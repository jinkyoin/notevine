// 질문 하나로 노트 + 웹 조사 → 답을 새 노트로 저장 (실제 AI·웹 검색 호출: 구독 사용량이 듭니다).
// 사용법: node tests/e2e/ai-research.cjs [claude|codex]
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROVIDER = process.argv[2] || "claude";
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "research-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n");
fs.writeFileSync(path.join(VAULT, "앱 업데이트 계획.md"), "# 앱 업데이트 계획\n\n현재 Tauri 2.11 사용 중. Tauri 최신 안정 버전으로 올릴지 검토하고 Windows 7 사용자 영향 확인 필요.\n");
fs.writeFileSync(path.join(VAULT, "비밀 메모.md"), "# 비밀 메모 #비공개\n\nTauri 최신 버전 전환 예산 3천만 원\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.evaluate((p) => {
    localStorage.setItem("notevine.ai.enabled", "1");
    localStorage.setItem("notevine.ai.provider", p);
    localStorage.removeItem("notevine.ai.web"); // default: web on
  }, PROVIDER);
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  await page.waitForSelector(".ai-head select", { timeout: 20000 });
  console.log("mode tabs gone:", !(await page.$(".ai-mode")));
  console.log("placeholder:", await page.getAttribute(".ai-input textarea", "placeholder"));

  await page.fill(".ai-input textarea", "Tauri 2 최신 안정 버전과 주요 변경점을 조사해 줘. 내 업데이트 계획과 관련해서도 정리해 줘.");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal.ai-send");
  console.log("offered:", await page.$$eval(".ai-notes li", (els) => els.map((e) => (e.querySelector("input").checked ? "[x] " : "[ ] ") + e.querySelector(".ai-note-title").textContent)));
  console.log("private notice:", await page.textContent(".ai-private").catch(() => "(없음)"));
  console.log("web option:", await page.$eval(".ai-web input", (i) => i.checked), (await page.textContent(".ai-web b")).trim());
  await page.click(".modal.ai-send .btn.primary");

  const t0 = Date.now();
  let lastSteps = 0;
  let st;
  while (true) {
    st = await page.evaluate(() => {
      const m = window.__notevineAi.getState().chat.at(-1);
      return { streaming: m.streaming, steps: m.progress ?? [], error: m.error, text: m.text };
    });
    if (st.steps.length > lastSteps) {
      st.steps.slice(lastSteps).forEach((s) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`));
      lastSteps = st.steps.length;
    }
    if (!st.streaming) break;
    if (Date.now() - t0 > 320000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`finished in ${((Date.now() - t0) / 1000).toFixed(0)}s, error: ${st.error}, chars: ${st.text.length}`);
  console.log("----- answer (앞부분) -----\n" + st.text.slice(0, 900) + "\n------------------");
  console.log("web links:", (st.text.match(/\]\(https?:\/\//g) || []).length, "note links:", st.text.match(/\[\[[^\]]+\]\]/g));
  console.log("private leaked:", st.text.includes("3천만") || st.text.includes("비밀 메모"));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", `ai-research-${PROVIDER}.png`) });

  await page.click(".ai-msg.ai >> nth=-1 >> .btn >> text=새 노트로 저장");
  await page.waitForTimeout(800);
  const saved = fs.readdirSync(VAULT, { recursive: true }).filter((f) => String(f).includes("AI 답변"));
  console.log("saved:", saved);
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
