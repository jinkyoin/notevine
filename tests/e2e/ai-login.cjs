// AI 로그인 안내 화면 확인 (실제 로그인·로그아웃 없음: 백엔드 응답을 흉내 낸다).
// Claude는 로그아웃 상태, Codex는 미설치로 보이게 한 뒤 로그인 버튼 흐름을 확인한다.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "login-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.evaluate(() => {
    localStorage.setItem("notevine.ai.enabled", "1");
    localStorage.setItem("notevine.ai.provider", "claude");
  });
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  // Let the real detection finish first so it cannot overwrite the fake one.
  await page.waitForFunction(() => window.__notevineAi.getState().providers !== null, null, { timeout: 15000 });

  // Fake backend: claude logged out until ai_login, codex not installed.
  await page.evaluate(() => {
    const api = window.__notevineApi;
    const state = { loggedIn: false, loginCalls: 0 };
    window.__fakeLogin = state;
    const list = () => [
      { id: "claude", name: "Claude Code", available: state.loggedIn, version: "2.1.312", logged_in: state.loggedIn, detail: state.loggedIn ? null : "로그인이 필요합니다" },
      { id: "codex", name: "Codex (ChatGPT)", available: false, version: null, logged_in: null, detail: "Codex CLI가 설치되어 있지 않습니다" },
    ];
    api.aiProviders = async () => list();
    api.aiLogin = async () => {
      state.loginCalls++;
      await new Promise((r) => setTimeout(r, 1500));
      state.loggedIn = true;
      return list()[0];
    };
    window.__notevineAi.setState({ providers: null });
  });

  await page.waitForSelector(".ai-connect");
  console.log("panel:", (await page.textContent(".ai-connect")).replace(/\s+/g, " ").trim());
  console.log("install cmd:", await page.textContent(".ai-install code"));

  // Asking while logged out points to login, not settings
  console.log("modal before ask:", await page.evaluate(() => window.__notevine.getState().modal));
  await page.evaluate(() => window.__notevineAi.getState().ask("테스트"));
  await page.waitForSelector(".toast.error");
  console.log("ask toast:", (await page.textContent(".toast.error")).replace(/\s+/g, " "));
  console.log("modal after ask:", await page.evaluate(() => window.__notevine.getState().modal));

  await page.click(".ai-connect .btn.primary:has-text('로그인')");
  await page.waitForSelector(".ai-connect >> text=로그인 창에서 진행 중");
  console.log("while open: button disabled =", await page.$eval(".ai-connect .btn.primary", (b) => b.disabled));
  await page.waitForSelector(".ai-head select", { timeout: 5000 });
  console.log("after login: provider =", await page.$eval(".ai-head select", (s) => s.value));
  console.log("toasts:", await page.$$eval(".toast", (ts) => ts.map((t) => t.textContent.replace(/\s+/g, " "))));
  console.log("input enabled:", await page.$eval(".ai-input textarea", (t) => !t.disabled));
  console.log("login calls:", await page.evaluate(() => window.__fakeLogin.loginCalls));

  // A login error in the chat offers the button too
  await page.evaluate(() =>
    window.__notevineAi.setState({
      chat: [
        { role: "user", text: "q" },
        { role: "ai", text: "", provider: "claude", error: "Claude Code에 로그인되어 있지 않습니다. 로그인 버튼을 눌러 로그인하세요" },
      ],
    }),
  );
  console.log("chat login button:", !!(await page.$(".ai-msg.ai .btn.primary:has-text('로그인')")));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "ai-login.png") });

  console.log("errors:", errors);
  await page.reload(); // drop the fake backend
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
