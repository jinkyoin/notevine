// 분할 창 (FR-EDT-07): 오른쪽에 나란히 열기, 양쪽 따로 편집·저장, 같은 노트 막기, 바꾸기·닫기. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "split-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "초안.md"), "# 초안\n\n쓰는 중\n");
fs.writeFileSync(path.join(VAULT, "자료.md"), "# 자료\n\n참고할 내용\n");
const read = (n) => fs.readFileSync(path.join(VAULT, n), "utf8");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  const row = (name) => `.tree-row:has(.tree-label:text-is("${name}"))`;
  const panes = () =>
    page.$$eval(".center > .pane", (ps) => ps.map((p) => p.querySelector(".note-title")?.textContent ?? p.textContent.trim().slice(0, 30)));

  await page.click(row("초안"));
  await page.waitForSelector(".note-title >> text=초안");
  if (await page.$(".note-view")) await page.keyboard.press("Control+e");

  // 1) Open 자료 on the right from the file tree.
  await page.click(row("자료"), { button: "right" });
  await page.click('.menu > li:text-is("오른쪽에 나란히 열기")');
  await page.waitForSelector(".split-pane .note-title >> text=자료");
  console.log("1 panes:", JSON.stringify(await panes()));

  // 2) Type in each side; each saves its own note.
  await page.click(".split-pane .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n오른쪽에서 씀");
  await page.click(".center > .pane:first-child .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n왼쪽에서 씀");
  await page.waitForTimeout(1800);
  console.log("2 saved:", read("자료.md").includes("오른쪽에서 씀"), read("초안.md").includes("왼쪽에서 씀"), "| crossed:", read("초안.md").includes("오른쪽"), read("자료.md").includes("왼쪽"));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "split.png") });

  // 3) Read mode on one side only.
  await page.click(".split-pane .fb-mode button:has-text('읽기')");
  await page.waitForTimeout(300);
  console.log("3 right reads, left edits:", !!(await page.$(".split-pane .note-view")), !(await page.$(".center > .pane:first-child .note-view")));

  // 4) Swap from the palette.
  await page.keyboard.press("Control+p");
  await page.keyboard.type("왼쪽·오른쪽");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".split-pane .note-title >> text=초안");
  console.log("4 swapped:", JSON.stringify(await panes()));

  // 5) Opening the right note on the left too: the right side steps back.
  await page.click(row("초안"));
  await page.waitForTimeout(500);
  console.log("5 same note:", JSON.stringify(await panes()));

  // 6) × closes the split.
  await page.click(".split-bar button[aria-label='나란히 보기 닫기']");
  await page.waitForTimeout(300);
  console.log("6 closed:", (await page.$$(".center > .pane")).length);

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
