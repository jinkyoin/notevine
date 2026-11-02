// 설정: 히스토리 사용량·정리 규칙(FR-HIS-08), 단축키 바꾸기·사용자 CSS(FR-UI-05). AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "settings-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n\n본문\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 1);
  await page.evaluate(() => window.__notevine.getState().openNote("메모.md"));
  await page.waitForSelector(".cm-content");
  if (await page.$(".note-view")) await page.keyboard.press("Control+e");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("한 줄 더");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(600);

  const openSettings = async (tab) => {
    await page.evaluate(() => window.__notevine.getState().setModal("settings"));
    await page.click(`.settings-tabs button:text-is("${tab}")`);
    await page.waitForTimeout(300);
  };
  const config = () => page.evaluate(() => window.__notevine.getState().config);

  // 1) History usage and policy.
  await openSettings("히스토리");
  const usage = await page.textContent('.set-row:has-text("사용량") .set-ctl');
  console.log("1 usage:", usage);
  const prune = '.set-row:has-text("정리") button:has-text("지금 정리")';
  console.log("1 prune disabled while off:", await page.isDisabled(prune));
  await page.selectOption('.set-row:has-text("오래된 버전 줄이기") select', "30");
  await page.waitForTimeout(300);
  console.log("1 thin days saved:", (await config()).history_thin_days);
  await page.click(prune);
  await page.waitForTimeout(500);
  console.log("1 toast:", await page.textContent(".toast").catch(() => null));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "settings-history.png") });

  // 2) Change the quick memo shortcut to Ctrl+M, see it work and show in the palette.
  await openSettings("단축키");
  await page.fill(".keys-tools input", "빠른 메모");
  await page.click('.keys-row:has-text("빠른 메모") .keys-btn');
  await page.keyboard.press("Control+m");
  await page.waitForTimeout(300);
  console.log("2 bound:", JSON.stringify((await config()).keybindings));
  console.log("2 row:", await page.textContent('.keys-row:has-text("빠른 메모")'));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "settings-keys.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__notevine.getState().setModal(null));
  await page.click(".cm-content");
  await page.keyboard.press("Control+Shift+n");
  await page.waitForTimeout(300);
  console.log("2 old key does nothing:", await page.evaluate(() => window.__notevine.getState().modal));
  await page.keyboard.press("Control+m");
  await page.waitForTimeout(300);
  console.log("2 new key opens:", await page.evaluate(() => window.__notevine.getState().modal));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__notevine.getState().setModal(null));
  await openSettings("단축키");
  await page.click('button:has-text("모두 기본값")');
  await page.waitForTimeout(300);
  console.log("2 reset:", JSON.stringify((await config()).keybindings));
  await page.evaluate(() => window.__notevine.getState().setModal(null));

  // 3) User CSS: the file is made on request and applied, and edits show on focus.
  const [cssPath] = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("custom_css", { create: true }));
  console.log("3 made:", fs.existsSync(cssPath));
  fs.writeFileSync(cssPath, ".note-title { color: rgb(255, 0, 0) !important; }");
  await page.evaluate(() => {
    const st = window.__notevine.getState();
    return st.saveConfig({ ...st.config, custom_css: true });
  });
  await page.waitForTimeout(500);
  const color = () => page.evaluate(() => getComputedStyle(document.querySelector(".note-title")).color);
  console.log("3 applied:", await color());
  fs.writeFileSync(cssPath, ".note-title { color: rgb(0, 0, 255) !important; }");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  console.log("3 reloaded on focus:", await color());
  await page.evaluate(() => {
    const st = window.__notevine.getState();
    return st.saveConfig({ ...st.config, custom_css: false });
  });
  await page.waitForTimeout(300);
  console.log("3 off:", await color(), (await page.$("#user-css")) === null);

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
