// 파일 트리의 노트·첨부를 열린 노트로 끌어다 놓으면 링크가 들어가는지 (복사 없음).
// 앱 안의 끌어 놓기라 Playwright가 실제 마우스 끌기로 한다. 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "treelink-" + Date.now());
fs.mkdirSync(path.join(VAULT, "자료"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "본문.md"), "# 본문\n\n첫 줄\n");
fs.writeFileSync(path.join(VAULT, "자료", "회의록.md"), "# 회의록\n");
fs.writeFileSync(path.join(VAULT, "자료", "견적서.xlsx"), "x");
fs.writeFileSync(path.join(VAULT, "자료", "구조도.png"), Buffer.from("89504e470d0a1a0a", "hex"));

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 2);
  await page.evaluate(() => {
    const s = window.__notevine.getState();
    s.setReadMode(false);
    s.openNote("본문.md");
    s.toggleFolder("자료", true);
  });
  await page.waitForSelector(".cm-content");
  await page.waitForSelector('.tree-row >> text=견적서.xlsx');
  await page.waitForTimeout(600);

  const row = (name) => page.locator(".tree-row", { hasText: name }).first();
  // A drag made of small mouse steps, which starts HTML drag-and-drop reliably.
  const drag = async (from, to, at) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 40, a.y + a.height / 2, { steps: 5 });
    await page.mouse.move(b.x + at.x, b.y + at.y, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(600);
  };
  const line = page.locator(".cm-line", { hasText: "첫 줄" });
  await drag(row("회의록"), line, { x: 300, y: 8 });
  await drag(row("견적서.xlsx"), page.locator(".editor"), { x: 300, y: 560 });
  await drag(row("구조도.png"), page.locator(".editor"), { x: 300, y: 600 });
  await drag(row("자료"), page.locator(".cm-line").first(), { x: 50, y: 8 });
  await page.waitForTimeout(1500);

  const text = await page.evaluate(() => window.__notevine.getState().docText);
  console.log("note:", JSON.stringify(text));
  console.log("files still where they were:", fs.readdirSync(path.join(VAULT, "자료")).sort().join(", "), "| 첨부 made:", fs.existsSync(path.join(VAULT, "첨부")));
  console.log("toasts:", JSON.stringify(await page.evaluate(() => window.__notevine.getState().toasts.map((t) => t.message))));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
