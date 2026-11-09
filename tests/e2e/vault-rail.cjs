// 노트 폴더 막대 (FR-VLT-07): 여러 노트 폴더를 막대에 두고 오가기. 돌아오면 노트·탭·스크롤이 그대로인지,
// 같은 이름의 노트가 두 폴더에 있어도 섞이지 않는지, 바꾸기 전에 저장되는지, 닫으면 다음 폴더로 가는지. AI 호출 없음.
// 개발 모드(디버깅 포트 9222)로 띄운 앱에 붙는다. [스크린샷 폴더]를 주면 화면을 남긴다.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TOP = path.join(os.tmpdir(), "notevine-e2e", "vault-rail-" + Date.now());
const A = path.join(TOP, "가 폴더");
const B = path.join(TOP, "나 폴더");
const GONE = path.join(TOP, "없는 폴더");
const SHOTS = process.argv[2];
const lines = (name) => [`# ${name}`, "", ...Array.from({ length: 120 }, (_, i) => `${name} 줄 ${i + 1}`)].join("\n\n");
for (const [dir, who] of [
  [A, "가"],
  [B, "나"],
]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "같은 이름.md"), lines(`같은 이름 ${who}`));
  fs.writeFileSync(path.join(dir, "둘째.md"), `# 둘째 ${who}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const st = (fn, arg) => page.evaluate(fn, arg);
  const invoke = (cmd, args) => st(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const root = () => st(() => window.__notevine.getState().vault?.root ?? null);
  const shot = async (name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, name + ".png") }));
  const ok = (cond, what) => {
    if (!cond) throw new Error("FAIL - " + what);
    console.log("ok - " + what);
  };
  const waitFor = async (fn, what, arg) => {
    for (let i = 0; i < 100; i++) {
      if (await st(fn, arg)) return;
      await sleep(100);
    }
    throw new Error("timeout - " + what);
  };
  const row = (name) => `.tree-row:has(.tree-label:text-is("${name}"))`;
  const editMode = async () => {
    if (await page.$(".note-view")) await page.keyboard.press("Control+e");
    await page.waitForSelector(".cm-host:not([hidden]) .cm-content");
  };
  const scrollTop = () => st(() => document.querySelector(".editor")?.scrollTop ?? -1);
  const isOn = (name) => st((n) => document.querySelector(".rail-btn.on")?.getAttribute("aria-label") === n, name);
  // The dev app's rail may hold other folders: the shortcut number is the folder's place on it.
  const key = async (name) => "Control+" + ((await st((n) => window.__notevine.getState().rail.findIndex((e) => e.name === n), name)) + 1);

  // The dev app's own rail is set aside for the test and put back after.
  const kept = (await invoke("rail_list", {}))?.entries ?? [];
  for (const e of kept) await invoke("rail_remove", { path: e.path });
  try {
    await page.reload();
    await page.waitForSelector(".main, .start-card");
    await st((v) => window.__notevine.getState().openVault(v), A);
    await st((v) => window.__notevine.getState().switchVault(v), B);
    await page.waitForSelector(".rail-btn.on");
    const labels = await st(() => [...document.querySelectorAll(".rail-btn:not(.add)")].map((b) => b.getAttribute("aria-label")));
    ok(labels.includes("가 폴더") && labels.includes("나 폴더") && (await isOn("나 폴더")), "두 폴더가 막대에 있고 나 폴더가 켜짐");
    await shot("1-rail");

    // A: open the long note and scroll down. B: same name, stays at the top.
    await page.click('.rail-btn[aria-label="가 폴더"]');
    await waitFor(() => window.__notevine.getState().vault?.name === "가 폴더", "A 열림");
    await page.click(row("같은 이름"));
    await editMode();
    await page.waitForSelector(".cm-content >> text=같은 이름 가 줄 1");
    await st(() => (document.querySelector(".editor").scrollTop = 1500));
    await sleep(300);
    const aTop = await scrollTop();
    await page.keyboard.press(await key("나 폴더"));
    await waitFor(() => window.__notevine.getState().vault?.name === "나 폴더", "Ctrl+2로 B");
    await page.click(row("같은 이름"));
    await editMode();
    await page.waitForSelector(".cm-content >> text=같은 이름 나 줄 1");
    ok((await scrollTop()) < 50, "B의 같은 이름 노트는 맨 위에서 열림(A의 스크롤과 안 섞임)");
    await page.keyboard.press(await key("가 폴더"));
    await waitFor(() => window.__notevine.getState().vault?.name === "가 폴더", "Ctrl+1로 A");
    await page.waitForSelector(".cm-content >> text=같은 이름 가");
    await sleep(300);
    ok(Math.abs((await scrollTop()) - aTop) < 40, `A로 돌아오면 같은 노트, 같은 스크롤(${aTop})`);

    // Two tabs in A survive a trip to B.
    await page.click(row("둘째"), { modifiers: ["Control"] });
    await page.waitForSelector(".note-title >> text=둘째");
    await page.keyboard.press(await key("나 폴더"));
    await waitFor(() => window.__notevine.getState().vault?.name === "나 폴더", "B");
    await page.keyboard.press(await key("가 폴더"));
    await waitFor(() => window.__notevine.getState().vault?.name === "가 폴더", "A");
    const tabs = await st(() => window.__notevine.getState().tabs.map((t) => t.path));
    const shownNow = await st(() => window.__notevine.getState().openPath);
    ok(tabs.length === 2 && shownNow === "둘째.md", `A의 탭 2개와 지금 탭이 그대로 (${JSON.stringify(tabs)} ${shownNow})`);

    // Typing then switching at once: the text is on disk.
    await editMode();
    await page.click(".cm-content");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("바꾸기 직전 입력");
    await page.keyboard.press(await key("나 폴더"));
    await waitFor(() => window.__notevine.getState().vault?.name === "나 폴더", "B");
    ok(fs.readFileSync(path.join(A, "둘째.md"), "utf8").includes("바꾸기 직전 입력"), "바꾸기 직전에 쓴 글이 저장됨");

    // Move B up above A: B now has A's old number.
    const aKey = await key("가 폴더");
    await page.click('.rail-btn[aria-label="나 폴더"]', { button: "right" });
    await page.click('.menu li:text-is("위로 옮기기")');
    await waitFor((k) => "Control+" + (window.__notevine.getState().rail.findIndex((e) => e.name === "나 폴더") + 1) === k, "순서 바뀜", aKey);
    await page.click('.rail-btn[aria-label="가 폴더"]');
    await waitFor(() => window.__notevine.getState().vault?.name === "가 폴더", "A");
    await page.keyboard.press(aKey);
    await waitFor(() => window.__notevine.getState().vault?.name === "나 폴더", "옮긴 뒤 번호가 B");
    ok(true, `위로 옮긴 뒤 ${aKey}가 나 폴더`);
    await shot("2-moved");

    // A folder that went away: a message, and the folder shown stays.
    await invoke("rail_add", { path: GONE, name: "없는 폴더" });
    await st(() => window.__notevine.getState().loadRail());
    await page.click('.rail-btn[aria-label="없는 폴더"]');
    await page.waitForSelector(".toast >> text=노트 폴더를 찾을 수 없습니다");
    ok((await root()).endsWith("나 폴더"), "없는 폴더를 누르면 알림, 보던 폴더 그대로");
    await page.click('.rail-btn[aria-label="없는 폴더"]', { button: "right" });
    await page.click('.menu li:text-is("막대에서 닫기")');
    await waitFor(() => !window.__notevine.getState().rail.some((e) => e.name === "없는 폴더"), "없는 폴더 닫힘");

    // "노트 폴더 더 열기" shows the start screen over the folder; Esc goes back.
    await page.click(".rail-btn.add");
    await page.waitForSelector(".start-overlay .start-card");
    await shot("3-adding");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".start-overlay", { state: "detached" });
    ok((await root()).endsWith("나 폴더"), "더 열기를 취소하면 그대로");

    // Closing the shown folder goes to the next one; closing the last shows the start screen.
    await st(() => window.__notevine.getState().closeRailVault());
    await waitFor(() => window.__notevine.getState().vault?.name === "가 폴더", "닫으면 다음 폴더");
    ok(true, "지금 폴더를 닫으면 다음 폴더로");
    ok((await st(() => window.__notevine.getState().rail.length)) === 1, "막대에 한 폴더만 남음");
    await st(() => window.__notevine.getState().closeRailVault());
    await page.waitForSelector(".start-card");
    ok(!(await page.$(".rail")), "마지막 폴더를 닫으면 시작 화면");
    ok(!(await st(() => window.__notevine.getState().toasts.some((t) => t.message.includes("열려 있지 않습니다")))), "바꾸는 동안 '노트 폴더가 열려 있지 않습니다' 알림 없음");
    ok(errors.length === 0, "페이지 오류 없음 " + errors.join(" | "));
  } finally {
    for (const p of [A, B, GONE]) {
      await invoke("rail_remove", { path: p }).catch(() => {});
      await invoke("forget_vault", { path: p }).catch(() => {});
    }
    for (const e of kept) await invoke("rail_add", { path: e.path, name: e.name }).catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
