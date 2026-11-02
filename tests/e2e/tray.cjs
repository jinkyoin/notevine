// 트레이 상주(FR-PRS-08)의 앱 쪽 확인. 창을 닫고 다시 띄우는 일은 바깥(PowerShell)에서 하고,
// 이 스크립트는 단계마다 상태만 확인한다. AI 호출 없음.
// 사용: node tray.cjs on → (창 닫기) → node tray.cjs state → (exe 다시 실행) → node tray.cjs state → node tray.cjs quit
// app-settings.json은 실제 Notevine과 함께 쓰므로 quit 단계에서 트레이를 다시 끈다.
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const invoke = (cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const step = process.argv[2];
  if (step === "on") {
    await invoke("set_tray", { on: true });
    console.log("settings:", JSON.stringify(await invoke("app_settings")));
  } else if (step === "state") {
    console.log("page alive:", await page.evaluate(() => !!window.__notevine), "| visibility:", await page.evaluate(() => document.visibilityState));
  } else if (step === "quit") {
    await invoke("set_tray", { on: false });
    console.log("settings:", JSON.stringify(await invoke("app_settings")));
    // What the tray's [종료] does: the window saves and closes for good.
    await invoke("plugin:event|emit", { event: "app-quit", payload: null }).catch((e) => console.log("emit:", String(e)));
  }
  await browser.close().catch(() => {});
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
