// 기본 구조 만들기의 폴더별 PARA 안내: '_안내' 노트, 파일 트리 마우스 올림 설명, 폴더 보기 설명,
// 보드에서는 안내 노트를 빼는지. 사용: node tests/e2e/para-guides.cjs [스크린샷 폴더]. 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SHOTS = process.argv[2] || os.tmpdir();
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "guides-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".main");
  void page.evaluate(() => window.__notevine.getState().applyPreset());
  await page.waitForSelector(".modal");
  console.log("dialog mentions guides:", (await page.locator(".modal").innerText()).includes("_안내"));
  await page.locator(".modal .btn.primary").click();
  await page.waitForFunction(() => window.__notevine.getState().config.preset_enabled);
  await page.waitForTimeout(800);
  console.log("toast:", JSON.stringify(await page.evaluate(() => window.__notevine.getState().toasts.map((t) => t.message))));
  const guides = ["00.Inbox", "10.프로젝트", "20.영역", "30.자료", "40.보관"].map((f) => [f, fs.existsSync(path.join(VAULT, f, "_안내.md"))]);
  console.log("guide notes:", JSON.stringify(guides));
  console.log("projects guide:\n" + fs.readFileSync(path.join(VAULT, "10.프로젝트", "_안내.md"), "utf8").split("\n").slice(0, 8).join("\n"));
  const title = await page.locator(".tree-row.folder", { hasText: "10.프로젝트" }).getAttribute("title");
  console.log("tree tooltip:", JSON.stringify(title));

  // The project folder as a board: the guide note is not a card.
  fs.writeFileSync(path.join(VAULT, "10.프로젝트", "홈페이지 개편.md"), "---\ntype: project\nstatus: 진행\n---\n# 홈페이지 개편\n");
  await page.evaluate(() => window.__notevine.getState().refreshTree());
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__notevine.getState().setTableView("10.프로젝트", "board"));
  await page.waitForSelector(".folder-table-head");
  await page.waitForTimeout(800);
  console.log("folder view info:", JSON.stringify(await page.locator(".folder-info").innerText()));
  console.log("board cards:", JSON.stringify(await page.locator(".board-card, .fb-card, [class*=card]").allInnerTexts().then((a) => a.map((s) => s.split("\n")[0]))));
  await page.screenshot({ path: path.join(SHOTS, "para-guides.png") });
  await page.evaluate(() => window.__notevine.getState().setTableView("10.프로젝트", "table"));
  await page.waitForTimeout(600);
  console.log("table lists guide:", (await page.locator(".folder-table").innerText()).includes("_안내"));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
