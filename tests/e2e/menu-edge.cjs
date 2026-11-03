// 창 아래쪽 폴더를 오른쪽 클릭해도 메뉴(폴더 색 포함)가 창 안에 다 보이는지.
// 사용: node tests/e2e/menu-edge.cjs [스크린샷 폴더]. 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SHOTS = process.argv[2] || os.tmpdir();
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "menuedge-" + Date.now());
for (let i = 1; i <= 30; i++) fs.mkdirSync(path.join(VAULT, `폴더 ${String(i).padStart(2, "0")}`), { recursive: true });
fs.writeFileSync(path.join(VAULT, "노트.md"), "# 노트\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row.folder");
  const vh = await page.evaluate(() => window.innerHeight);

  // The lowest folder row still on screen.
  const rows = page.locator(".tree-row.folder");
  let target = null;
  for (let i = (await rows.count()) - 1; i >= 0; i--) {
    const b = await rows.nth(i).boundingBox();
    if (b && b.y + b.height < vh - 4) {
      target = { row: rows.nth(i), box: b };
      break;
    }
  }
  await target.row.click({ button: "right", position: { x: 30, y: target.box.height / 2 } });
  await page.waitForSelector(".menu .menu-swatches");
  await page.waitForTimeout(200);
  const m = await page.locator(".menu").boundingBox();
  const sw = await page.locator(".menu .menu-swatches").boundingBox();
  console.log(`clicked at y=${Math.round(target.box.y)} of ${vh} | menu ${Math.round(m.y)}..${Math.round(m.y + m.height)} | colors ${Math.round(sw.y)}..${Math.round(sw.y + sw.height)} | inside: ${m.y >= 0 && m.y + m.height <= vh}`);
  await page.screenshot({ path: path.join(SHOTS, "menu-edge.png") });
  const name = (await target.row.innerText()).trim();
  await page.locator(".menu .menu-swatch").nth(2).click();
  await page.waitForTimeout(400);
  console.log("color set:", name, JSON.stringify(await page.evaluate((n) => window.__notevine.getState().config.folder_colors[n.split("\n")[0].trim()], name)));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
