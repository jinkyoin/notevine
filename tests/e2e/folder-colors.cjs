// 파일 트리 폴더 색: 우클릭 메뉴로 색 지정, 안의 노트·폴더도 같은 색, 폴더 자기 색이 우선. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "colors-" + Date.now());
const w = (rel, t) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), t);
};
w("업무/계획.md", "# 계획\n");
w("업무/회의/주간.md", "# 주간\n");
w("개인/메모.md", "# 메모\n");
w("밖.md", "# 밖\n");

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
  const colors = () =>
    page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll(".tree-row")].map((r) => [r.querySelector(".tree-label")?.textContent, getComputedStyle(r).color])),
    );
  const pick = async (folder, name) => {
    await page.click(row(folder), { button: "right" });
    await page.click(`.menu .menu-swatch[aria-label="${name}"]`);
    await page.waitForTimeout(300);
  };

  for (const f of ["업무", "개인"]) await page.click(row(f));
  await page.click(row("회의"));
  await page.waitForSelector(row("주간"));

  await pick("업무", "파랑");
  console.log("1 업무 blue:", JSON.stringify(await colors()));
  await pick("회의", "빨강");
  console.log("2 회의 red inside blue 업무:", JSON.stringify(await colors()));
  await page.click(row("업무"), { button: "right" });
  await page.waitForSelector(".menu-colors");
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "folder-colors-menu.png") });
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 400);

  // Rename keeps the colors; the config file holds them.
  await page.evaluate(() => window.__notevine.getState().rename("업무", "회사"));
  await page.waitForSelector(row("회사"));
  await page.waitForTimeout(300);
  console.log("3 after rename 업무 → 회사:", JSON.stringify(await colors()));
  console.log("  config:", JSON.stringify(JSON.parse(fs.readFileSync(path.join(VAULT, ".app/config.json"), "utf8")).folder_colors));

  // The renamed folder stays open.
  await page.waitForSelector(row("주간"));
  await pick("회의", "색 없음");
  console.log("4 회의 cleared (takes 회사's blue):", JSON.stringify(await colors()));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "folder-colors.png") });

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
