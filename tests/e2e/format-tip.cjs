// 서식 막대 단추의 툴팁: 마우스 포인터에 가리지 않게 단추 위에 뜬다. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "tip-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n\n본문\n");

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

  for (const label of ["제목 1", "굵게", "글자 색", "마크다운 문법 도움말"]) {
    const btn = page.locator(`.format-bar [aria-label="${label}"]`).first();
    await btn.hover();
    await page.waitForTimeout(150);
    const r = await page.evaluate((l) => {
      const b = document.querySelector(`.format-bar [aria-label="${l}"]`).getBoundingClientRect();
      const t = document.querySelector(".fb-tip");
      if (!t) return null;
      const tr = t.getBoundingClientRect();
      return { text: t.textContent, above: tr.bottom <= b.top, left: tr.left >= 0 };
    }, label);
    console.log(label, JSON.stringify(r));
  }
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "format-tip.png") });
  await page.mouse.move(600, 500);
  await page.waitForTimeout(100);
  console.log("gone after leaving:", (await page.$(".fb-tip")) === null);
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
