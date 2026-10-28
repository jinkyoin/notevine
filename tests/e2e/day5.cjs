// Day-5 UI check: search (Korean 2-char partial, tag, property, phrase), quick open,
// properties panel edits ↔ frontmatter.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const OUT = path.join(require("os").tmpdir(), "notevine-e2e", "shots");
const VAULT = path.join(require("os").tmpdir(), "notevine-e2e", "searchvault-" + Date.now());
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), text);
};

w("20 아이디어/업무개선 아이디어.md", "---\ntype: idea\nstatus: 검토\ntags: [업무개선, 자동화]\n---\n# 업무개선 아이디어\n\n반복 보고를 줄이는 업무개선 방법을 정리한다.\n");
w("30 조사자료/자동화 도구 조사.md", "---\ntype: research\nstatus: 진행\nsource: https://example.com/report\n---\n자동화 도구는 업무개선 효과가 크다. #자동화\n");
w("일지/2026-10-28.md", "오늘은 회의만 했다.\n");
w("화면 설계 회의록 1027.md", "회의록 본문\n");

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
  await sleep(1000);

  const search = async (q) => {
    await page.fill(".search-input", q);
    await sleep(600);
    return {
      summary: (await page.textContent(".result-summary").catch(() => "")).trim(),
      titles: await page.$$eval(".results .r-title", (els) => els.map((e) => e.textContent)),
      marks: await page.$$eval(".results mark", (els) => els.map((e) => e.textContent)),
    };
  };

  if (!process.env.SKIP_SEARCH) {
  // 1) search tab via Ctrl+Shift+F
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector(".search-input");
  console.log("무개 →", JSON.stringify(await search("무개")));
  console.log("#업무개선 →", JSON.stringify(await search("#업무개선")));
  console.log("status:검토 →", JSON.stringify(await search("status:검토")));
  console.log("type!=idea 자동화 →", JSON.stringify(await search("type!=idea 자동화")));
  console.log('"보고를 줄이는" →', JSON.stringify(await search('"보고를 줄이는"')));
  await search("무개");
  await page.screenshot({ path: path.join(OUT, "10-search.png") });
  // result click opens the note at the match line
  await page.click(".results li >> nth=0");
  await page.waitForSelector(".note-title");
  console.log("opened from result:", await page.textContent(".note-title"));

  }
  // 2) quick open
  await page.keyboard.press("Control+o");
  await page.waitForSelector(".palette-input");
  await page.keyboard.type("회의");
  await sleep(150);
  console.log("quick open:", await page.$$eval(".palette-list li", (els) => els.map((e) => e.textContent)));
  await page.screenshot({ path: path.join(OUT, "11-quickopen.png") });
  await page.keyboard.press("Enter");
  await page.waitForSelector(".note-title >> text=화면 설계 회의록 1027");

  // 3) properties panel
  await page.evaluate(() => window.__notevine.getState().openNote("20 아이디어/업무개선 아이디어.md"));
  await page.waitForSelector(".prop-row");
  console.log("props:", await page.$$eval(".prop-row .prop-key", (els) => els.map((e) => e.textContent)));
  const status = page.locator(".prop-row:has(.prop-key:text-is('status')) input");
  await status.fill("진행");
  await status.press("Enter");
  await page.fill(".prop-row.t-list .chip-input", "회고");
  await page.press(".prop-row.t-list .chip-input", "Enter");
  await page.fill(".prop-add input", "due");
  await page.press(".prop-add input", "Enter");
  await sleep(1800);
  const file = fs.readFileSync(path.join(VAULT, "20 아이디어/업무개선 아이디어.md"), "utf8");
  console.log("frontmatter after panel edits:\n" + file.split("---")[1]);
  await page.screenshot({ path: path.join(OUT, "12-props.png") });

  // 4) YAML typed in the editor shows in the panel
  await page.click(".cm-content");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("owner: 김기록\n");
  await sleep(600);
  console.log("panel sees typed key:", (await page.$$eval(".prop-key", (els) => els.map((e) => e.textContent))).includes("owner"));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
