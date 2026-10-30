// PARA 활용: 새 프로젝트, 보관으로 옮기기(링크 고침), 보관에서 꺼내기. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "para-act-" + Date.now());
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
  await page.click(".modal button:has-text('켜기')");
  await page.waitForSelector('.tree-row:has(.tree-label:text-is("10.프로젝트"))');
  const row = (name) => `.tree-row:has(.tree-label:text-is("${name}"))`;
  const menu = async (name) => {
    await page.click(row(name), { button: "right" });
    await page.waitForSelector(".menu");
    return page.$$eval(".menu > li:not(.menu-colors)", (li) => li.map((l) => l.textContent));
  };
  const pickMenu = (label) => page.click(`.menu > li:text-is("${label}")`);

  // 1) New project from the project folder's menu.
  console.log("1 menu on 10.프로젝트:", JSON.stringify(await menu("10.프로젝트")));
  await pickMenu("새 프로젝트");
  const input = await page.waitForSelector(".tree-input");
  console.log("  input starts as:", await input.inputValue());
  await input.fill("홈페이지 개편");
  await input.press("Enter");
  await page.waitForSelector(".note-title >> text=홈페이지 개편");
  const proj = "10.프로젝트/홈페이지 개편/홈페이지 개편.md";
  console.log("  opened:", await page.evaluate(() => window.__notevine.getState().openPath));
  console.log("  overview:", JSON.stringify(fs.readFileSync(path.join(VAULT, proj), "utf8").slice(0, 120)));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "para-new-project.png") });

  // A note elsewhere links to the project's overview.
  fs.writeFileSync(path.join(VAULT, "00.Inbox/메모.md"), "[[10.프로젝트/홈페이지 개편/홈페이지 개편]] 참고\n");
  await page.evaluate(() => window.__notevine.getState().refreshTree());
  await page.waitForTimeout(500);

  // 2) Archive the project folder; the link follows.
  console.log("2 menu on the project:", JSON.stringify(await menu("홈페이지 개편")));
  await pickMenu("보관으로 옮기기");
  if (await page.waitForSelector(".modal", { timeout: 1500 }).catch(() => null)) {
    console.log("  asks about links:", (await page.textContent(".modal h2")).trim());
    await page.click(".modal button.primary");
  }
  await page.waitForTimeout(800);
  console.log("  moved:", fs.existsSync(path.join(VAULT, "40.보관/홈페이지 개편/홈페이지 개편.md")), "| left:", fs.existsSync(path.join(VAULT, "10.프로젝트/홈페이지 개편")));
  console.log("  link now:", JSON.stringify(fs.readFileSync(path.join(VAULT, "00.Inbox/메모.md"), "utf8").trim()));

  // 3) Take it back out to the areas.
  await page.click(row("40.보관"));
  await page.waitForSelector(row("홈페이지 개편"));
  console.log("3 menu inside the archive:", JSON.stringify(await menu("홈페이지 개편")));
  await pickMenu("영역으로 꺼내기");
  if (await page.waitForSelector(".modal", { timeout: 1500 }).catch(() => null)) await page.click(".modal button.primary");
  await page.waitForTimeout(800);
  console.log("  now in 20.영역:", fs.existsSync(path.join(VAULT, "20.영역/홈페이지 개편/홈페이지 개편.md")));

  // 4) Roots offer nothing PARA; the palette has "새 프로젝트".
  console.log("4 menu on 20.영역:", JSON.stringify(await menu("20.영역")));
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 500);
  await page.keyboard.press("Control+p");
  await page.keyboard.type("새 프로젝트");
  await page.waitForTimeout(200);
  console.log("  palette:", JSON.stringify(await page.$$eval(".palette-list li", (li) => li.map((l) => l.textContent).slice(0, 3))));
  await page.keyboard.press("Escape");

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
