// 기본 구조 만들기(PARA): 확인 창, 만들어진 폴더, 오늘 업무일지 위치. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "para-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".main");

  await page.click("button:has-text('기본 구조 만들기')");
  await page.waitForSelector(".modal");
  console.log("1 dialog:\n" + (await page.textContent(".modal")));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "preset-para-dialog.png") });
  await page.click(".modal button:has-text('켜기')");
  await page.waitForTimeout(800);

  const dirs = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(VAULT, rel), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      dirs.push(r);
      walk(r);
    }
  };
  walk("");
  console.log("2 folders on disk:", JSON.stringify(dirs));
  console.log("  idea template folder:", /folder: (.*)/.exec(fs.readFileSync(path.join(VAULT, "90 템플릿/아이디어.md"), "utf8"))[1]);

  await page.keyboard.press("Control+Shift+D");
  await page.waitForTimeout(800);
  console.log("3 today's journal:", await page.evaluate(() => window.__notevine.getState().openPath));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "preset-para.png") });

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
