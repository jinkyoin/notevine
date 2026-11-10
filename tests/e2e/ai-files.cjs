// AI 입력 칸에 노트가 아닌 파일(PDF·엑셀·CSV 등)을 끌어다 놓기 (FR-AI-03), 파일은 더블클릭으로 열기.
// 사용: node tests/e2e/ai-files.cjs <한글이 든 PDF> [xlsx 파일] [--ask]   (개발 앱 9222. --ask일 때만 실제 AI 호출)
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ASK = process.argv.includes("--ask");
const [PDF, XLSX] = process.argv.slice(2).filter((a) => a !== "--ask");
if (!PDF) throw new Error("PDF 경로를 주세요");
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "ai-files-" + Date.now());
fs.mkdirSync(path.join(VAULT, "자료"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n\n본문\n");
fs.copyFileSync(PDF, path.join(VAULT, "자료", "제안요청서.pdf"));
if (XLSX) fs.copyFileSync(XLSX, path.join(VAULT, "자료", "설계서.xlsx"));
fs.writeFileSync(path.join(VAULT, "자료", "일정.csv"), "단계,기간\n착수,1월\n");
fs.writeFileSync(path.join(VAULT, "자료", "요약.md"), "# 요약\n\n요약 노트\n");
fs.writeFileSync(path.join(VAULT, "사진.png"), Buffer.from("89504e470d0a1a0a", "hex"));

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
  const row = (name) => `.tree-row:has(.tree-label:text-is("${name}"))`;
  await page.click(row("자료"));
  await page.waitForSelector(row("제안요청서.pdf"));
  const st = () => page.evaluate(() => window.__notevine.getState());

  // 1) Other files open on a double click only.
  await page.click(row("제안요청서.pdf"));
  await page.waitForTimeout(500);
  console.log("1 single click opens pdf:", !!(await page.$(".pdf-page")));
  await page.dblclick(row("제안요청서.pdf"));
  await page.waitForSelector(".pdf-page", { timeout: 15000 });
  console.log("1 double click opens pdf: true");
  await page.evaluate(() => window.__notevine.getState().openNote("메모.md"));
  await page.waitForSelector(".note-title >> text=메모");

  // 2) A PDF dropped on the AI box: a 📎 chip, its text read.
  await page.dragAndDrop(row("제안요청서.pdf"), ".ai-input");
  await page.waitForSelector(".ai-chip >> text=제안요청서.pdf", { timeout: 15000 });
  const chips = await page.$$eval(".ai-chip > span", (ss) => ss.map((s) => s.textContent));
  console.log("2 chips:", JSON.stringify(chips));

  // 3) A folder brings its notes and readable files.
  await page.dragAndDrop(row("자료"), ".ai-input");
  await page.waitForSelector(".ai-chip >> text=📁", { timeout: 15000 });
  console.log("3 chips:", JSON.stringify(await page.$$eval(".ai-chip > span", (ss) => ss.map((s) => s.textContent))));

  // 4) A picture is refused.
  await page.dragAndDrop(row("사진.png"), ".ai-input");
  await page.waitForSelector(".toast.error >> text=글자를 읽을 수 있는 파일");
  console.log("4 picture refused: true");

  // 5) What the chips send (their tooltip lists it). With --ask, a real question to Claude Code
  //    (uses a little of the subscription) must answer from the PDF's text.
  const titles = await page.$$eval(".ai-chip", (ss) => ss.map((s) => s.getAttribute("title")));
  console.log("5 sends:", JSON.stringify(titles));
  if (!titles.join(" ").includes("자료/일정.csv")) throw new Error("folder files not attached");
  if (ASK) {
    await page.fill(".ai-input textarea", "과업 범위와 사업 기간을 알려 줘");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-msg.ai:not(.streaming) >> text=유지관리", { timeout: 180000 });
    console.log("5 answer:", (await page.textContent(".ai-msg.ai")).slice(0, 200));
  }

  console.log("errors:", errors);
  await page.reload();
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
