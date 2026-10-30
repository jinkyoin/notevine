// 편집기 위 제목·편집/읽기 단추·서식 막대가 스크롤해도 화면에 남는지. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "top-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(
  path.join(VAULT, "긴 노트.md"),
  ["# 긴 노트", "", ...Array.from({ length: 120 }, (_, i) => `줄 ${i + 1}`)].join("\n\n"),
);

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.evaluate(() => window.__notevine.getState().openNote("긴 노트.md"));
  if (await page.waitForSelector(".note-view", { timeout: 1500 }).catch(() => null)) await page.keyboard.press("Control+e");
  await page.waitForSelector(".cm-host:not([hidden]) .cm-content");

  // Where the title, mode switch and format bar sit relative to the scrolling area.
  const place = () =>
    page.evaluate(() => {
      const box = document.querySelector(".editor").getBoundingClientRect().top;
      const at = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top - box);
      return { scroll: Math.round(document.querySelector(".editor").scrollTop), title: at(".note-title"), modes: at(".mode-switch, .editor-head button"), bar: at(".format-bar") };
    });
  console.log("1 at the top:", JSON.stringify(await place()));
  await page.evaluate(() => (document.querySelector(".editor").scrollTop = 3000));
  await page.waitForTimeout(200);
  console.log("2 edit mode scrolled:", JSON.stringify(await place()));

  // Moving the cursor up with the keyboard keeps it below the pinned header.
  await page.click(".cm-content");
  for (let i = 0; i < 25; i++) await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  const cursor = await page.evaluate(() => {
    const top = document.querySelector(".editor-top").getBoundingClientRect().bottom;
    const c = document.querySelector(".cm-cursor").getBoundingClientRect().top;
    return { headerBottom: Math.round(top), cursorTop: Math.round(c) };
  });
  console.log("3 cursor after ArrowUp ×25 (cursor below header):", JSON.stringify(cursor), cursor.cursorTop >= cursor.headerBottom);
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "editor-top-edit.png") });

  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  await page.evaluate(() => (document.querySelector(".editor").scrollTop = 3000));
  await page.waitForTimeout(200);
  console.log("4 read mode scrolled:", JSON.stringify(await place()));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "editor-top-read.png") });

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
