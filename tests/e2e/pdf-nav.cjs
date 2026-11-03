// PDF·캔버스 보기에서 돌아가기(단추·Esc·Alt+←)와 링크 표시(파일 이름만)를 확인한다.
// 사용: node tests/e2e/pdf-nav.cjs <PDF 파일> [스크린샷 폴더]. 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PDF = process.argv[2];
const SHOTS = process.argv[3] || os.tmpdir();
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "pdfnav-" + Date.now());
fs.mkdirSync(path.join(VAULT, "자료"), { recursive: true });
fs.copyFileSync(PDF, path.join(VAULT, "자료", "계획서.pdf"));
fs.writeFileSync(path.join(VAULT, "자료", "견적서.xlsx"), "x");
fs.writeFileSync(path.join(VAULT, "자료", "회의록.md"), "# 회의록\n");
fs.writeFileSync(path.join(VAULT, "본문.md"), "# 본문\n\n계획: [[자료/계획서.pdf]]\n견적: [[자료/견적서.xlsx]]\n회의: [[자료/회의록]]\n이름 붙임: [[자료/견적서.xlsx|올해 견적]]\n\n끝\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 2);
  const st = () => page.evaluate(() => ({ pdf: window.__notevine.getState().pdfView?.path ?? null, canvas: window.__notevine.getState().canvasView, open: window.__notevine.getState().openPath }));
  await page.evaluate(() => {
    window.__notevine.getState().setReadMode(false);
    window.__notevine.getState().openNote("본문.md");
  });
  await page.waitForSelector(".cm-content");
  // The cursor on the last line, so the link lines show as links.
  await page.click(".cm-line >> text=끝");
  await page.waitForTimeout(400);
  console.log("editor shows:", JSON.stringify(await page.locator(".cm-content").innerText()));
  await page.evaluate(() => window.__notevine.getState().setReadMode(true));
  await page.waitForSelector(".note-view a.wikilink");
  console.log("read mode shows:", JSON.stringify(await page.locator(".note-view a.wikilink").allInnerTexts()));

  // Open the PDF from the link, then come back three ways.
  await page.locator(".note-view a.wikilink", { hasText: "계획서" }).click({ modifiers: ["Control"] });
  await page.waitForSelector(".pdf-view");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, "pdf-nav.png") });
  console.log("opened:", JSON.stringify(await st()));
  await page.locator(".view-back").click();
  console.log("back button →", JSON.stringify(await st()));

  await page.evaluate(() => window.__notevine.getState().openPdf("자료/계획서.pdf"));
  await page.waitForSelector(".pdf-view");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  console.log("Esc (no click first) →", JSON.stringify(await st()));

  await page.evaluate(() => window.__notevine.getState().openPdf("자료/계획서.pdf"));
  await page.waitForSelector(".pdf-view");
  await page.waitForTimeout(300);
  await page.keyboard.press("Alt+ArrowLeft");
  console.log("Alt+← →", JSON.stringify(await st()));

  // The same for a canvas.
  await page.evaluate(() => window.__notevine.getState().createCanvas(""));
  await page.waitForSelector(".canvas-stage");
  await page.keyboard.press("Escape"); // ends naming it in the tree
  await page.waitForTimeout(300);
  await page.locator(".view-back").click();
  console.log("canvas back button →", JSON.stringify(await st()));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
