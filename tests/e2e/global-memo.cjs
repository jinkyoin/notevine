// 다른 프로그램을 쓰는 중에 Ctrl+Alt+N(FR-PRS-08): 창이 앞으로 오고 빠른 메모가 열리는지.
// 창을 최소화하고 키를 보내는 일은 바깥(PowerShell)에서 한다. 이 스크립트는 그 전후 상태만 확인한다.
// 사용: node global-memo.cjs prepare  →  다른 창을 앞에 두고 Ctrl+Alt+N  →  node global-memo.cjs check
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  if (process.argv[2] === "prepare") {
    await page.evaluate(() => window.__notevine.getState().setModal(null));
    console.log("prepared:", await page.evaluate(() => window.__notevine.getState().modal));
  } else {
    await page.waitForTimeout(500);
    const modal = await page.evaluate(() => window.__notevine.getState().modal);
    console.log("modal:", modal, "| visible:", await page.evaluate(() => document.visibilityState));
    await page.evaluate(() => window.__notevine.getState().setModal(null));
  }
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
