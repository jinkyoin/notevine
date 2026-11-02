// PDF 보기·주석과 웹 클리핑(FR-ATT-03). AI 호출 없음. 웹 클리핑은 실제 웹 페이지 하나에 접속한다.
// 사용: node pdf-clip.cjs <한글이 든 PDF 경로>   (앱 페이지는 localhost:1420 또는 빌드한 tauri.localhost)
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PDF = process.argv[2];
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "pdf-" + Date.now());
fs.mkdirSync(path.join(VAULT, "첨부"), { recursive: true });
fs.copyFileSync(PDF, path.join(VAULT, "첨부", "계획서.pdf"));
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n\n[[첨부/계획서.pdf]] 와 [[첨부/계획서.pdf#page=3|3쪽]]\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 1);
  const st = (f) => page.evaluate(f);

  // 1) Clicking the PDF in the file tree opens it in the app, Korean text selectable.
  await page.click('.tree-row:has-text("첨부"), li:has-text("첨부") >> nth=0').catch(() => {});
  await page.evaluate(() => window.__notevine.getState().toggleFolder("첨부", true));
  await page.click('text="계획서.pdf"');
  await page.waitForSelector(".pdf-page .textLayer span", { timeout: 15000 });
  const text = await page.$$eval(".pdf-page[data-page='1'] .textLayer span", (ss) => ss.map((s) => s.textContent).join(""));
  console.log("1 pages:", await page.textContent(".pdf-pages"), "| page 1 text:", JSON.stringify(text.slice(0, 40)));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "pdf-view.png") });

  // 2) Select text on page 1, add an annotation with a memo.
  const box = await page.$eval(".pdf-page[data-page='1'] .textLayer", (el) => {
    const span = [...el.querySelectorAll("span")].find((s) => s.textContent.includes("착수보고"));
    const r = span.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
  await page.mouse.move(box.x + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w - 2, box.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".pdf-pick");
  await page.click(".pdf-pick");
  await page.fill(".pdf-form textarea", "일정표에 넣기");
  await page.click('.pdf-form button:has-text("주석 저장")');
  await page.waitForTimeout(1200);
  const note = fs.readFileSync(path.join(VAULT, "첨부", "계획서 주석.md"), "utf8");
  console.log("2 note:", JSON.stringify(note.split("\n").slice(-5)));
  console.log("2 side list:", JSON.stringify(await page.$$eval(".pdf-note", (bs) => bs.map((b) => b.textContent))));
  console.log("2 highlighted spans:", (await page.$$(".pdf-page[data-page='1'] .pdf-hl")).length);
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "pdf-annot.png") });

  // 3) A page link from a note opens the PDF at that page.
  await st(() => window.__notevine.getState().closePdf());
  await st(() => window.__notevine.getState().followLink("첨부/계획서.pdf", "page=3"));
  await page.waitForSelector(".pdf-page[data-page='3'] .textLayer span", { timeout: 15000 });
  await page.waitForTimeout(500);
  console.log("3 at page:", await page.inputValue(".pdf-page-input"));
  await page.keyboard.press("Escape");
  await st(() => window.__notevine.getState().closePdf());

  // 4) Clip a web page into a note.
  const ok = await page.evaluate(() => window.__notevine.getState().clipWebPage("https://example.com/"));
  await page.waitForTimeout(800);
  const open = await st(() => window.__notevine.getState().openPath);
  console.log("4 clipped:", ok, open);
  if (open) console.log("4 note head:", JSON.stringify(fs.readFileSync(path.join(VAULT, open), "utf8").slice(0, 160)));
  const bad = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("fetch_page", { url: "file:///C:/Windows/win.ini" }).catch((e) => e.message));
  console.log("4 file: refused:", JSON.stringify(bad));

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
