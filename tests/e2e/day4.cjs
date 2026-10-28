// Day-4 UI check: [[ completion, Ctrl+click, missing-link creation, backlinks panel,
// rename with link updates (SCR-15).
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const OUT = path.join(require("os").tmpdir(), "notevine-e2e", "shots");
const VAULT = path.join(require("os").tmpdir(), "notevine-e2e", "linkvault-" + Date.now());
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


fs.mkdirSync(path.join(VAULT, "일지"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "30 조사자료"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "30 조사자료", "회의록.md"), "# 회의록\n\n결정 사항\n");
fs.writeFileSync(path.join(VAULT, "일지", "a.md"), "오늘 일지\n\n표준 링크: [자료](../30%20조사자료/회의록.md)\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.reload();
  await page.waitForSelector(".start-card, .tree-row");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  await sleep(800); // background index scan

  // 1) [[ completion with a Korean partial
  await page.evaluate(() => window.__notevine.getState().openNote("일지/a.md"));
  await page.waitForSelector(".cm-content");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n위키 링크: [[의록");
  await page.waitForSelector(".cm-tooltip-autocomplete li", { timeout: 3000 });
  const options = await page.$$eval(".cm-tooltip-autocomplete li", (els) => els.map((e) => e.textContent));
  console.log("completion options:", options);
  await page.screenshot({ path: path.join(OUT, "7-complete.png") });
  await page.keyboard.press("Enter");
  await page.keyboard.type(" 없는 링크: [[새 아이디어]]");
  await page.keyboard.press("Control+s");
  await sleep(1200);
  const a = fs.readFileSync(path.join(VAULT, "일지", "a.md"), "utf8");
  console.log("completed text:", JSON.stringify(a.split("\n").pop()));

  // 2) Ctrl+click an existing link → opens 회의록; backlinks show both links from a.md
  await page.keyboard.press("Control+Home"); // move cursor off the link line so marks render
  await page.click(".cm-wikilink:not(.cm-wikilink-missing)", { modifiers: ["Control"] });
  await page.waitForSelector(".note-title >> text=회의록");
  await page.waitForSelector(".bl-line", { timeout: 3000 });
  const bl = await page.$$eval(".bl-line", (els) => els.map((e) => e.textContent));
  console.log("backlinks of 회의록:", bl);
  await page.screenshot({ path: path.join(OUT, "8-backlinks.png") });

  // 3) backlink click jumps back to the linking line
  await page.click(".bl-line >> nth=0");
  await page.waitForSelector(".note-title >> text=a");
  // 4) Ctrl+click a missing link creates the note
  await page.keyboard.press("Control+Home");
  await page.click(".cm-wikilink-missing", { modifiers: ["Control"] });
  await page.waitForSelector(".note-title >> text=새 아이디어");
  console.log("missing link created:", fs.existsSync(path.join(VAULT, "새 아이디어.md")));

  // 5) rename 회의록 → dialog lists a.md; confirm rewrites both links
  await page.evaluate(() => window.__notevine.getState().rename("30 조사자료/회의록.md", "회의록 1027"));
  await page.waitForSelector(".modal", { timeout: 3000 });
  console.log("dialog:", (await page.textContent(".modal p")).trim(), await page.$$eval(".change-list li", (els) => els.map((e) => e.textContent)));
  await page.screenshot({ path: path.join(OUT, "9-relocate.png") });
  await page.click(".modal .btn.primary");
  await page.waitForSelector(".modal", { state: "detached" });
  await sleep(500);
  console.log("a.md after rename:\n" + fs.readFileSync(path.join(VAULT, "일지", "a.md"), "utf8"));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
