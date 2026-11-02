// `#태그` 자동완성과 노트 맨 아래 태그 줄: 기존 태그를 많이 쓴 순으로 제안, Enter로 넣기, 줄 맨 앞 `# 제목`·코드 안에서는 안 뜸. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "tags-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "a.md"), "#회의 #업무\n");
fs.writeFileSync(path.join(VAULT, "b.md"), "---\ntags: [회의, 회의록]\n---\n본문\n");
fs.writeFileSync(path.join(VAULT, "c.md"), '#회의\n<span style="color: #1c7ed6">2026. 11. 30</span> 마감\n');
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 4);
  await page.evaluate(() => window.__notevine.getState().openNote("메모.md"));
  await page.waitForSelector(".cm-content");
  if (await page.$(".note-view")) await page.keyboard.press("Control+e");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  const tip = () =>
    page.evaluate(() => {
      const t = document.querySelector(".cm-tooltip-autocomplete");
      return t && t.getBoundingClientRect().top > 0 ? [...t.querySelectorAll("li")].map((l) => l.textContent) : null;
    });

  // 1) "#회" offers 회의 (3 notes) before 회의록 (1), on screen.
  await page.keyboard.type("오늘 #회");
  await page.waitForTimeout(600);
  console.log("1 offered:", JSON.stringify(await tip()));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "tags.png") });

  // 2) Arrow down + Enter puts 회의록 in.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const lastLine = () => page.evaluate(() => [...document.querySelectorAll(".cm-line")].pop().textContent);
  console.log("2 line:", JSON.stringify(await lastLine()));

  // 3) A heading at the line start shows nothing; a # glued to a word neither.
  await page.keyboard.press("Enter");
  await page.keyboard.type("#");
  await page.waitForTimeout(500);
  const atStart = await tip();
  await page.keyboard.type(" 제목");
  await page.keyboard.press("Enter");
  await page.keyboard.type("C#");
  await page.waitForTimeout(500);
  console.log("3 no popup for heading / C#:", atStart === null, (await tip()) === null);

  // 4) Not inside a code block.
  await page.keyboard.press("Enter");
  await page.keyboard.type("```\n#회");
  await page.waitForTimeout(500);
  console.log("4 no popup in code:", (await tip()) === null);

  // 5) The note's tags show at the bottom, in edit and read mode; a click searches the tag.
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(1200);
  const footer = () => page.$$eval(".note-tags button", (bs) => bs.map((b) => b.textContent));
  console.log("5 footer (edit):", JSON.stringify(await footer()));
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  console.log("5 footer (read):", JSON.stringify(await footer()));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "tags-footer.png") });
  await page.evaluate(() => window.__notevine.getState().openNote("b.md"));
  await page.waitForSelector(".note-title >> text=b");
  await page.waitForTimeout(500);
  console.log("5 property tags:", JSON.stringify(await footer()));
  // A text color (<span style="color: #1c7ed6">) is not a tag.
  await page.evaluate(() => window.__notevine.getState().openNote("c.md"));
  await page.waitForSelector(".note-title >> text=c");
  await page.waitForTimeout(500);
  const all = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("all_tags"));
  console.log("5 colored text:", JSON.stringify(await footer()), "| all tags:", JSON.stringify(all.map((t) => t.tag)));
  await page.evaluate(() => window.__notevine.getState().openNote("b.md"));
  await page.waitForSelector(".note-title >> text=b");
  await page.waitForTimeout(300);
  await page.click('.note-tags button:text-is("#회의록")');
  await page.waitForTimeout(500);
  console.log("5 search:", await page.inputValue(".search-input"));
  await page.evaluate(() => window.__notevine.getState().openNote("메모.md"));
  await page.waitForTimeout(300);

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
