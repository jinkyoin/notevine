// 웹 자료 조사 → 새 노트 (실제 AI·웹 검색 호출: 구독 사용량이 듭니다).
// 사용법: node tests/e2e/ai-research.cjs [claude|codex]
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROVIDER = process.argv[2] || "claude";
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "research-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.evaluate((p) => {
    localStorage.setItem("notevine.ai.enabled", "1");
    localStorage.setItem("notevine.ai.provider", p);
  }, PROVIDER);
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  await page.waitForSelector(".ai-head select", { timeout: 20000 });

  // Command palette entry switches the panel to research mode
  await page.keyboard.press("Control+p");
  await page.keyboard.type("자료 조사");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-mode button.active >> text=자료 조사");
  console.log("placeholder:", await page.getAttribute(".ai-input textarea", "placeholder"));

  await page.fill(".ai-input textarea", "Tauri 2 최신 안정 버전과 주요 변경점");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal.ai-send");
  console.log("confirm notice:", (await page.textContent(".ai-web")).replace(/\s+/g, " "));
  await page.click(".modal.ai-send .btn.primary");

  await page.waitForSelector(".modal.ai-preview");
  const t0 = Date.now();
  let lastSteps = 0;
  while (true) {
    const st = await page.evaluate(() => {
      const p = window.__notevineAi.getState().preview;
      return p && { streaming: p.streaming, steps: p.progress ?? [], error: p.error, len: p.result.length };
    });
    if (st.steps.length > lastSteps) {
      st.steps.slice(lastSteps).forEach((s) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`));
      lastSteps = st.steps.length;
    }
    if (!st.streaming) {
      console.log(`finished in ${((Date.now() - t0) / 1000).toFixed(0)}s, error: ${st.error}, chars: ${st.len}`);
      break;
    }
    if (Date.now() - t0 > 320000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 1000));
  }
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", `ai-research-${PROVIDER}.png`) });
  const result = await page.inputValue(".ai-result");
  console.log("----- result -----\n" + result.slice(0, 1500) + "\n------------------");
  console.log("has sections:", ["## 요약", "## 주요 내용", "## 참고 자료"].map((h) => result.includes(h)));
  console.log("links:", (result.match(/\]\(https?:\/\//g) || []).length);

  await page.click(".modal.ai-preview .btn.primary"); // 새 노트로 만들기
  await page.waitForSelector(".note-title >> text=조사 -");
  const open = await page.evaluate(() => window.__notevine.getState().openPath);
  console.log("note:", open, "on disk:", fs.existsSync(path.join(VAULT, open)) || "(checking)");
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
