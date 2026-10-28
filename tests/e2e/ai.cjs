// AI 도우미 화면 테스트 (FR-AI-01~06). 실제로 Claude Code(또는 Codex)를 불러 작은 질의를 몇 번 한다.
// 개발 모드 앱이 9222 포트로 떠 있어야 한다 (tests/e2e/README.md).
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const OUT = path.join(os.tmpdir(), "notevine-e2e", "shots");
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "ai-" + Date.now());
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), text);
};
const read = (rel) => fs.readFileSync(path.join(VAULT, rel), "utf8");

// This week's journal days
const now = new Date();
const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const d1 = mon;
const d2 = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 1);

w("회의록 1027.md", "# 회의록 1027\n\n참석: 김, 이, 박\n\n## 결정 사항\n- 주간 보고는 금요일 오후 4시까지 올린다\n- 배포는 다음 주 화요일로 미룬다\n");
w("아이디어/보고 자동화.md", "보고서 양식을 템플릿으로 만들어 주간 보고를 자동화하자.\n");
w(`10 업무일지/${d1.getFullYear()}/${ymd(d1)}.md`, `# ${ymd(d1)} 업무일지\n\n## 완료한 일\n- 킥오프 회의 진행\n- 요구사항 초안 작성\n`);
w(`10 업무일지/${d2.getFullYear()}/${ymd(d2)}.md`, `# ${ymd(d2)} 업무일지\n\n## 완료한 일\n- 화면 설계 검토\n## 막힌 일\n- 테스트 서버 권한 대기\n`);
w("초안.md", "# 초안\n\n이번주는 회의가 너무많아서 집중해서 일할시간이 부족햇다 다음주엔 회의를 줄여야겟다\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.evaluate(() => localStorage.setItem("notevine.ai.enabled", "0"));
  await page.reload();
  await page.waitForSelector(".start-card, .tree-row, .empty");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  await sleep(800);

  // 1) AI tab is off by default; turn it on, providers get detected
  await page.keyboard.press("Control+j");
  await page.waitForSelector(".ai-off");
  await page.click(".ai-off .btn.primary");
  await page.waitForSelector(".ai-head select", { timeout: 15000 });
  console.log("providers:", await page.$$eval(".ai-head option", (els) => els.map((e) => e.textContent)));

  // 2) ask a question → SCR-19 lists notes → send → streamed answer with [[links]]
  await page.fill(".ai-input textarea", "지난 회의에서 결정한 것이 뭐야?");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal.ai-send", { timeout: 10000 });
  console.log("send dialog notes:", await page.$$eval(".ai-notes .ai-note-title", (els) => els.map((e) => e.textContent)));
  await page.screenshot({ path: path.join(OUT, "ai-1-send.png") });
  await page.click(".modal.ai-send .btn.primary");
  await page.waitForSelector(".ai-msg.ai .ai-actions", { timeout: 180000 });
  const answer = await page.textContent(".ai-msg.ai .ai-text");
  console.log("answer:", JSON.stringify(answer.slice(0, 300)));
  console.log("answer cites note:", (await page.$$eval(".ai-msg.ai .ai-link", (els) => els.map((e) => e.textContent))).join(", "));
  await page.screenshot({ path: path.join(OUT, "ai-2-answer.png") });

  // 3) save the answer as a note
  await page.click(".ai-actions button >> text=새 노트로 저장");
  await page.waitForSelector(".toast >> text=답변을 노트로 저장했습니다");
  const saved = fs.readdirSync(VAULT).find((n) => n.startsWith("AI 답변"));
  console.log("saved answer note:", saved, saved && read(saved).includes("## 참고한 노트"));

  // 4) cancelling the send dialog sends nothing
  await page.fill(".ai-input textarea", "아무거나");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal.ai-send");
  await page.click(".modal.ai-send .btn.ghost");
  await sleep(300);
  console.log("cancel leaves chat length:", await page.$$eval(".ai-msg", (els) => els.length));

  // 5) editor: polish the current paragraph → preview → replace
  await page.evaluate(() => window.__notevine.getState().openNote("초안.md"));
  await page.waitForSelector(".note-title >> text=초안");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Control+p");
  await page.keyboard.type("AI: 다듬기");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal.ai-send");
  console.log("write dialog shows paragraph:", (await page.textContent(".ai-extra-text")).includes("회의가 너무많아서"));
  await page.click(".modal.ai-send .btn.primary");
  await page.waitForSelector(".modal.ai-preview");
  await page.waitForFunction(() => !document.querySelector(".ai-result")?.readOnly && document.querySelector(".ai-result")?.value, null, { timeout: 180000 });
  const polished = await page.inputValue(".ai-result");
  console.log("polished:", JSON.stringify(polished.slice(0, 200)));
  await page.screenshot({ path: path.join(OUT, "ai-3-preview.png") });
  await page.click(".modal.ai-preview .btn.primary");
  await page.keyboard.press("Control+s");
  await sleep(1200);
  console.log("note replaced:", !read("초안.md").includes("너무많아서") && read("초안.md").includes(polished.trim().slice(0, 10)));
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+s");
  await sleep(1200);
  console.log("undo restores original:", read("초안.md").includes("너무많아서"));

  // 6) weekly review from this week's journal → new note
  await page.keyboard.press("Control+p");
  await page.keyboard.type("주간 회고");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal.ai-send");
  console.log("review sends:", await page.$$eval(".ai-notes .ai-note-title", (els) => els.map((e) => e.textContent)));
  await page.click(".modal.ai-send .btn.primary");
  await page.waitForFunction(() => !document.querySelector(".ai-result")?.readOnly && document.querySelector(".ai-result")?.value, null, { timeout: 180000 });
  await page.click(".modal.ai-preview .btn.primary");
  await page.waitForSelector(".note-title >> text=주간 회고");
  const review = fs.readdirSync(path.join(VAULT, "10 업무일지")).find((n) => n.startsWith("주간 회고"));
  console.log("review note:", review, JSON.stringify(read(path.join("10 업무일지", review)).slice(0, 200)));

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
