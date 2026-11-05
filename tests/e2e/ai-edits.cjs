// AI 노트 작업: 이 PC의 Ollama(기본 gemma3:4b)로 실제 제안을 받아 확인 창 → 적용 → 히스토리까지 본다.
// 노트는 PC 밖으로 나가지 않는다. 개발 빌드를 --remote-debugging-port=9222로 띄운 뒤 실행.
// 사용: node tests/e2e/ai-edits.cjs [스크린샷 폴더] [모델]
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SHOTS = process.argv[2] || os.tmpdir();
const MODEL = process.argv[3] || "gemma3:4b";
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "aiedits-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
const MEETING = "# 주간 회의 11-03\n\n## 결정사항\n- 홈페이지 개통은 3월로 한다\n- 검색 개선을 1순위로 한다\n\n## 할 일\n- 질의서 작성 (담당: 미정)\n";
fs.writeFileSync(path.join(VAULT, "주간 회의 11-03.md"), MEETING);
fs.writeFileSync(path.join(VAULT, "비밀.md"), "# 비밀\n\n#비공개\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 2);
  await page.evaluate((m) => {
    const ai = window.__notevineAi.getState();
    ai.setEnabled(true);
    ai.setProvider("ollama");
    ai.setModel("ollama", m);
  }, MODEL);
  await page.evaluate(() => window.__notevine.getState().openNote("주간 회의 11-03.md"));
  await page.waitForSelector(".cm-content");

  // Send a request from the panel's one box.
  await page.locator(".ai-input textarea").fill(
    "이 회의록의 결정사항을 모아 '결정사항 모음' 새 노트를 만들고, 할 일의 '담당: 미정'을 '담당: 김민수'로 바꿔 줘.",
  );
  await page.keyboard.press("Enter");
  // The send dialog lists the open note; send it.
  await page.waitForSelector(".modal .btn.primary");
  const sendText = await page.locator(".modal").innerText();
  console.log("send dialog mentions note:", sendText.includes("주간 회의 11-03"), "| private note offered:", sendText.includes("비밀"));
  await page.locator(".modal .btn.primary").click();
  const t0 = Date.now();
  await page.waitForSelector(".ai-edits");
  await page.waitForFunction(() => !window.__notevineAi.getState().running, null, { timeout: 280000 });
  console.log("AI seconds:", ((Date.now() - t0) / 1000).toFixed(1));
  const st = await page.evaluate(() => {
    const e = window.__notevineAi.getState().edits;
    return e && { message: e.message, items: e.items.map((i) => ({ kind: i.edit.kind, path: i.path, error: i.error, checked: i.checked })) };
  });
  console.log("message:", JSON.stringify(st.message));
  console.log("items:", JSON.stringify(st.items));
  await page.screenshot({ path: path.join(SHOTS, "ai-edits.png") });

  const ready = st.items.filter((i) => !i.error).length;
  if (ready) {
    await page.locator(".ae-foot .btn.primary").click();
    await page.waitForFunction(() => !window.__notevineAi.getState().edits, null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    const meeting = await page.evaluate(() => window.__notevineApi.readNote("주간 회의 11-03.md"));
    console.log("meeting now:", JSON.stringify(meeting));
    const created = st.items.find((i) => i.kind === "create" && !i.error);
    if (created) console.log("created note:", JSON.stringify(await page.evaluate((p) => window.__notevineApi.readNote(p), created.path)));
    const versions = await page.evaluate(() => window.__notevineApi.listVersions("주간 회의 11-03.md"));
    console.log("history versions of meeting:", versions.length);
    console.log("toasts:", JSON.stringify(await page.evaluate(() => window.__notevine.getState().toasts.map((t) => t.message))));
  }
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
