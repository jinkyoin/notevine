// #비공개 태그 노트가 AI로 나가지 않는지 확인 (AI 호출 없음: 확인 창에서 취소하거나 백엔드가 거절).
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "private-" + Date.now());
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), text);
};
w("공개 회의.md", "# 공개 회의\n\n배포 일정 회의: 화요일 배포\n");
w("인사 회의.md", "# 인사 회의 #비공개\n\n배포 일정 회의 중 연봉 논의\n");
w("회사 메모.md", "---\ntags: [비공개/회사]\n---\n배포 일정 회의 메모\n");

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
  await page.waitForSelector(".ai-head select", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));

  // 1) question while a private note is open: neither private note is offered
  await page.evaluate(() => window.__notevine.getState().openNote("인사 회의.md"));
  await page.waitForSelector(".note-title >> text=인사 회의");
  await page.fill(".ai-input textarea", "배포 일정 회의 내용 정리해 줘");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal.ai-send");
  console.log("offered:", await page.$$eval(".ai-notes .ai-note-title", (els) => els.map((e) => e.textContent)));
  console.log("notice:", await page.textContent(".ai-private").catch(() => "(없음)"));
  await page.click(".modal.ai-send .btn.ghost"); // cancel: nothing sent

  // 2) AI writing on a private note is refused before any dialog
  await page.click(".cm-content");
  await page.evaluate(() => window.__notevine.getState().toasts.forEach((t) => window.__notevine.getState().dismissToast(t.id)));
  await page.keyboard.press("Control+p");
  await page.keyboard.type("AI: 요약");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".toast.error >> text=#비공개", { timeout: 5000 });
  console.log("write refused:", (await page.textContent(".toast.error")).includes("보내지 않습니다"), "dialog shown:", !!(await page.$(".modal.ai-send")));

  // 3) the backend refuses even when asked directly
  const direct = await page.evaluate(async () => {
    try {
      const { Channel } = window.__TAURI_INTERNALS__;
      await window.__TAURI_INTERNALS__.invoke("ai_run", {
        requestId: "t-private",
        provider: "claude",
        system: "",
        prompt: "x",
        notes: ["회사 메모.md"],
        model: null,
        onEvent: "__CHANNEL__:" + window.__TAURI_INTERNALS__.transformCallback(() => {}),
      });
      return "sent?!";
    } catch (e) {
      return e.message ?? String(e);
    }
  });
  console.log("direct ai_run:", direct);
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
