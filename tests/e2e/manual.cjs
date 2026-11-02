// 앱 안 사용자 매뉴얼(Shift+F1): 열리고, 목차·본문 링크로 그 제목에 가고, 다이어그램이 그려지는지. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "manual-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 1);
  await page.click(".topbar");

  await page.keyboard.press("Shift+F1");
  await page.waitForSelector(".modal.manual .manual-body h2");
  const toc = await page.$$eval(".manual-toc button", (bs) => bs.map((b) => b.textContent));
  console.log("1 toc:", toc.length, JSON.stringify(toc.slice(0, 3)));

  // Where a heading sits relative to the top of the scrolling body.
  const offset = (id) =>
    page.evaluate((id) => {
      const body = document.querySelector(".manual-body");
      const h = document.getElementById(id);
      return h ? Math.round(h.getBoundingClientRect().top - body.getBoundingClientRect().top) : null;
    }, id);

  await page.click('.manual-toc button:has-text("9. 히스토리와 복원")');
  await page.waitForTimeout(300);
  console.log("2 toc jump offset:", await offset("9-히스토리와-복원"), "| current:", await page.textContent(".manual-toc button.on"));

  await page.click('.manual-body a[data-dest="#52-검색"]');
  await page.waitForTimeout(300);
  console.log("3 link jump offset:", await offset("52-검색"), "| current:", await page.textContent(".manual-toc button.on"));

  await page.waitForSelector(".manual-body [data-mermaid].drawn svg", { timeout: 10000 }).catch(() => {});
  console.log("4 diagram drawn:", !!(await page.$(".manual-body [data-mermaid].drawn svg")));
  await page.click('.manual-toc button:has-text("2. 화면 구성")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "manual.png") });

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  console.log("5 closed:", await page.evaluate(() => window.__notevine.getState().modal));
  await page.keyboard.press("F1");
  await page.click('.md-help button:has-text("사용자 매뉴얼")');
  console.log("6 from markdown help:", await page.evaluate(() => window.__notevine.getState().modal));
  await page.keyboard.press("Escape");
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
