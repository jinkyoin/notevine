// 웹 클리핑: 열린 노트가 있으면 커서 자리에(읽기 모드면 끝에) 넣고, 없으면 새 노트로 만든다 (FR-ATT-03).
// 사용: node tests/e2e/web-clip-into.cjs [표가 있는 페이지 주소]   (개발 앱 9222. 그 페이지에 실제로 접속한다)
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const URL = process.argv[2] || "https://ko.wikipedia.org/wiki/%EB%8C%80%ED%95%9C%EB%AF%BC%EA%B5%AD%EC%9D%98_%ED%96%89%EC%A0%95_%EA%B5%AC%EC%97%AD";
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "clip-into-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "조사.md"), "---\ntags: [조사]\n---\n# 조사\n\n앞 문단\n\n뒤 문단\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 1);
  const st = (fn) => page.evaluate(fn);
  const clip = async () => {
    await st(() => window.__notevine.getState().setModal("clip"));
    await page.waitForSelector(".web-clip");
    const hint = await page.textContent(".web-clip p.muted");
    await page.fill(".clip-url", URL);
    await page.click('.web-clip button:has-text("가져오기")');
    await page.waitForSelector(".web-clip", { state: "detached", timeout: 60000 });
    await page.waitForTimeout(800);
    return hint;
  };

  // 1) Open note, cursor after "앞 문단": the clip goes there, the properties stay.
  await st(() => window.__notevine.getState().openNote("조사.md"));
  await page.waitForSelector(".cm-content");
  if (await page.$(".note-view")) await page.keyboard.press("Control+e");
  await page.click(".cm-line >> text=앞 문단");
  await page.keyboard.press("End");
  console.log("1 hint:", (await clip()).slice(0, 60));
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(800);
  const text = fs.readFileSync(path.join(VAULT, "조사.md"), "utf8");
  const notes = await st(() => window.__notevine.getState().notes.length);
  console.log("1 notes in folder:", notes, "| starts:", JSON.stringify(text.slice(0, 40)));
  const at = text.indexOf("## ");
  console.log("1 order ok:", text.indexOf("앞 문단") < at && at < text.indexOf("뒤 문단"), "| tables:", (text.match(/^\| --- /gm) || []).length);
  if (notes !== 1 || !(at > text.indexOf("앞 문단") && at < text.indexOf("뒤 문단"))) throw new Error("clip not put in the open note");

  // 2) Nothing open: a new note.
  await st(() => {
    const s = window.__notevine.getState();
    for (const t of [...s.tabs]) s.closeTab(t.path ?? t);
  });
  await page.waitForTimeout(500);
  console.log("2 open:", await st(() => window.__notevine.getState().openPath));
  console.log("2 hint:", (await clip()).slice(0, 40));
  console.log("2 notes in folder:", await st(() => window.__notevine.getState().notes.length));

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
