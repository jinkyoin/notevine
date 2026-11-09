// FR-VLT-10: 탐색기 '연결 프로그램'처럼 파일 경로를 넘겨 실행했을 때. 릴리스 exe를 직접 띄운다.
// 먼저 npm run tauri build. 실행 중인 Notevine을 닫고 돌린다. 임시 폴더는 최근 목록에서 지운다.
const { chromium } = require("playwright-core");
const { spawn, spawnSync, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXE = path.join(__dirname, "..", "..", "src-tauri", "target", "release", "notevine.exe");
const TOP = path.join(os.tmpdir(), "notevine-e2e", "open-file");
const VAULT = path.join(TOP, "노트 폴더");
const OUTSIDE = path.join(TOP, "받은 파일");
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(TOP, { recursive: true, force: true });
fs.mkdirSync(path.join(VAULT, ".app"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "자료"), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
const write = (file, text) => (fs.writeFileSync(file, text), file);
const inVault = write(path.join(VAULT, "자료", "안쪽 노트.md"), "표식-안쪽\n");
const inVault2 = write(path.join(VAULT, "둘째 노트.md"), "표식-둘째\n");
const outside = write(path.join(OUTSIDE, "바깥 노트.md"), "표식-바깥\n");

const invoke = (page, cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const body = (page) => page.evaluate(() => document.body.innerText);

async function see(page, text, what) {
  for (let i = 0; i < 100; i++) {
    // The page may still be loading when the app has just started: try again.
    if ((await body(page).catch(() => "")).includes(text)) return console.log(`ok - ${what}`);
    await sleep(100);
  }
  throw new Error(`${what}: "${text}" not on screen\n${(await body(page)).slice(0, 400)}`);
}

/** A second launch, as Explorer does while the app runs: it hands over and exits. */
const openAgain = (file) => spawnSync(EXE, [file], { timeout: 15000 });

(async () => {
  const proc = spawn(EXE, [inVault], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });
  let b, page;
  try {
    for (let i = 0; i < 200 && !page; i++) {
      try {
        b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
        page = b.contexts()[0]?.pages()[0];
      } catch {}
      if (!page) await sleep(100);
    }
    if (!page) throw new Error("could not connect to the app");

    await see(page, "표식-안쪽", "시작할 때 넘긴 파일이 그 노트 폴더에서 열림");
    // FR-VLT-07: a folder not on the rail opens only for now, shown with a dashed button.
    const onRail = async () => ((await invoke(page, "rail_list"))?.entries ?? []).filter((e) => e.path.startsWith(TOP)).map((e) => e.name);
    await page.waitForSelector('.rail-btn.temp[aria-label="노트 폴더"]');
    if ((await onRail()).length) throw new Error("the folder opened from Explorer was saved on the rail");
    console.log("ok - 탐색기에서 연 막대 밖 폴더는 점선 단추로만 보이고 막대에 저장되지 않음");

    openAgain(inVault2);
    await see(page, "표식-둘째", "실행 중에 같은 노트 폴더의 파일을 넘기면 바로 열림");

    openAgain(outside);
    await page.waitForSelector('[role="alertdialog"]', { timeout: 10000 });
    console.log("ok - 노트 폴더 밖의 파일은 먼저 물음");
    if (fs.existsSync(path.join(OUTSIDE, ".app"))) throw new Error(".app was created before the answer");
    await page.click('[role="alertdialog"] .btn.ghost');
    await sleep(500);
    if (fs.existsSync(path.join(OUTSIDE, ".app"))) throw new Error(".app was created after cancel");
    await see(page, "표식-둘째", "취소하면 지금 노트 폴더가 그대로이고 .app이 생기지 않음");

    openAgain(outside);
    await page.waitForSelector('[role="alertdialog"]', { timeout: 10000 });
    await page.click('[role="alertdialog"] .btn.primary');
    await see(page, "표식-바깥", "확인하면 그 폴더를 열고 파일을 보여 줌");
    if (!fs.existsSync(path.join(OUTSIDE, ".app"))) throw new Error("no .app after opening");
    await page.waitForSelector('.rail-btn.temp[aria-label="받은 파일"]');
    if ((await page.$$(".rail-btn.temp")).length !== 1) throw new Error("more than one temporary folder");
    if ((await onRail()).length) throw new Error("the folder made a note folder from Explorer was saved on the rail");
    console.log("ok - '노트 폴더로 열기'로 연 폴더도 잠깐 연 폴더 하나로만 보임");
    // "막대에 추가" is left to store.rail.test.ts: this run uses the installed app's settings,
    // and a rail file made here would stay behind as an emptied rail.

    openAgain(path.join(OUTSIDE, "없는 노트.md"));
    await see(page, "없는 노트.md", "없는 파일은 알림으로 알려 줌");

    if (fs.readFileSync(outside, "utf8") !== "표식-바깥\n") throw new Error("the note changed");
    console.log("ok - 노트 파일은 바뀌지 않음");
  } finally {
    if (page) {
      const recent = await invoke(page, "recent_vaults").catch(() => []);
      for (const v of recent) {
        if (v.path.startsWith(TOP)) await invoke(page, "forget_vault", { path: v.path }).catch(() => {});
      }
    }
    await b?.close().catch(() => {});
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
