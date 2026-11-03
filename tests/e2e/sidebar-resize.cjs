// 사이드바·오른쪽 패널 폭 조절: 가장자리 끌기, 다시 열어도 유지, 두 번 누르면 처음 폭,
// 최소·최대(가운데 노트 자리 400px은 남김), 손잡이 선 색.
// 사용: node tests/e2e/sidebar-resize.cjs [스크린샷 폴더]. 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SHOTS = process.argv[2] || os.tmpdir();
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "resize-" + Date.now());
fs.mkdirSync(path.join(VAULT, "아주 긴 이름의 프로젝트 폴더 - 2026년 대표 홈페이지 유지관리"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "노트.md"), "# 노트\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.evaluate(() => {
    localStorage.removeItem("notevine.sidebarWidth");
    localStorage.removeItem("notevine.rightWidth");
  });
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".panel-resizer.right");
  const widths = () =>
    page.evaluate(() => {
      const w = (s) => Math.round(document.querySelector(s)?.getBoundingClientRect().width ?? 0);
      return `left ${w(".sidebar")} · center ${w(".center")} · right ${w(".rightpanel")}`;
    });
  const drag = async (side, dx) => {
    const b = await page.locator(`.panel-resizer.${side}`).boundingBox();
    const x = b.x + b.width / 2;
    const y = b.y + 300;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 10 });
    await page.mouse.up();
  };

  console.log("start:", await widths());
  await drag("right", -120);
  console.log("right edge 120px left:", await widths());
  // Hovered, the line shows in the muted gray.
  const rb = await page.locator(".panel-resizer.right").boundingBox();
  await page.mouse.move(rb.x + 4, rb.y + 200);
  await page.waitForTimeout(250);
  const color = await page.evaluate(() => getComputedStyle(document.querySelector(".panel-resizer.right"), "::after").backgroundColor);
  const muted = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted").trim());
  console.log("line color:", color, "(--muted", muted + ")");
  await page.screenshot({ path: path.join(SHOTS, "panels-resize.png") });
  await page.reload();
  await page.waitForSelector(".panel-resizer.right");
  console.log("after reload:", await widths());
  await drag("right", 300);
  console.log("right as narrow as it goes:", await widths());
  await drag("left", 2000);
  await drag("right", -2000);
  console.log("both as wide as they go:", await widths());
  await page.locator(".panel-resizer.left").dblclick();
  await page.locator(".panel-resizer.right").dblclick();
  console.log("double-click both:", await widths());
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
