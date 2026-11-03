// 파일 트리의 파일을 연결된 프로그램으로 여는지. 실제 프로그램이 뜨지 않게 store의 openExternal을 바꿔 기록만 한다.
// 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "openext-" + Date.now());
fs.mkdirSync(path.join(VAULT, "자료"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "자료", "견적서.xlsx"), "x");
fs.writeFileSync(path.join(VAULT, "자료", "회의록.md"), "# 회의록\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  // Record what would open instead of starting programs (Tauri's invoke can't be replaced,
  // so the store action is). The action itself is a one-liner around the OS opener.
  await page.evaluate(() => {
    window.__opened = [];
    window.__notevine.setState({ openExternal: async (p) => void window.__opened.push(p) });
  });
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row.folder");
  await page.evaluate(() => window.__notevine.getState().toggleFolder("자료", true));
  await page.waitForSelector(".tree-row >> text=견적서.xlsx");

  await page.locator(".tree-row", { hasText: "견적서.xlsx" }).click();
  await page.waitForTimeout(500);
  console.log("click on xlsx →", JSON.stringify(await page.evaluate(() => window.__opened)));

  await page.locator(".tree-row", { hasText: "회의록" }).click({ button: "right" });
  console.log("note menu:", (await page.locator(".menu li").allInnerTexts()).filter((t) => /열기/.test(t)).join(" | "));
  await page.locator(".menu li", { hasText: "연결된 프로그램으로 열기" }).click();
  await page.waitForTimeout(500);
  console.log("menu on note →", JSON.stringify(await page.evaluate(() => window.__opened)));
  console.log("note still opens in the app on click:");
  await page.locator(".tree-row", { hasText: "회의록" }).click();
  await page.waitForTimeout(400);
  console.log("  openPath:", await page.evaluate(() => window.__notevine.getState().openPath));
  await page.locator(".tree-row.folder").first().click({ button: "right" });
  console.log("folder menu has it:", (await page.locator(".menu li").allInnerTexts()).some((t) => t.includes("연결된 프로그램")));
  await page.keyboard.press("Escape");
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
