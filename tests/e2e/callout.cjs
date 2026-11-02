// 강조 상자(> [!중요]): 서식 막대 메뉴로 넣고, 편집·읽기 모드에서 색 상자로 보이는지. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "callout-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(
  path.join(VAULT, "메모.md"),
  "# 메모\n\n> [!주의] 마감 임박\n> 11월 30일까지 제출\n\n> 그냥 인용\n\n> [!tip]\n> 영어 이름도 됨\n\n",
);

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 1);
  await page.evaluate(() => window.__notevine.getState().openNote("메모.md"));
  await page.waitForSelector(".cm-content");
  if (await page.$(".note-view")) await page.keyboard.press("Control+e");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");

  // 1) Insert an important box from the menu, then type into it.
  await page.click('.format-bar [aria-label="강조 상자"]');
  const items = await page.$$eval(".fb-callouts button", (bs) => bs.map((b) => b.textContent));
  console.log("1 menu:", JSON.stringify(items));
  await page.click('.fb-callouts button:has-text("중요")');
  await page.keyboard.type("계약 금액은 연도별로 정한다.");
  await page.keyboard.press("ArrowUp"); // cursor off the last line… then away from the box
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(300);
  const doc = await page.evaluate(() => window.__notevine.getState().editorApi?.getText?.() ?? null);
  const lines = await page.$$eval(".cm-line.cm-callout", (ls) => ls.map((l) => l.className.match(/cm-callout-(\w+)/g).join(" ")));
  const labels = await page.$$eval(".cm-callout-label", (ls) => ls.map((l) => l.textContent));
  console.log("1 edit lines:", JSON.stringify(lines));
  console.log("1 labels:", JSON.stringify(labels));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "callout-edit.png") });

  // 2) Saved text and read mode.
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(800);
  console.log("2 file tail:", JSON.stringify(fs.readFileSync(path.join(VAULT, "메모.md"), "utf8").slice(-40)));
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  const boxes = await page.$$eval(".note-view .callout", (bs) =>
    bs.map((b) => [b.className, b.querySelector(".callout-title").textContent, b.querySelector(".callout-body")?.textContent.trim()]),
  );
  console.log("2 read boxes:", JSON.stringify(boxes));
  console.log("2 plain quote kept:", (await page.$$(".note-view blockquote")).length);
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "callout-read.png") });
  console.log("doc api:", doc === null ? "n/a" : "ok");
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
