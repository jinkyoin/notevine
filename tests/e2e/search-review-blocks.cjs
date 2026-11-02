// 저장된 검색(FR-SRC-06), 주간·월간 회고 묶음(FR-PRS-08), 블록 링크·제목 자동완성(FR-LNK-07). AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "srb-" + Date.now());
const d = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const files = {
  "10.프로젝트/웹/웹.md": "---\ntype: project\nstatus: 진행\ndeadline: 2026-12-31\n---\n# 웹\n",
  "10.프로젝트/이사/이사.md": "---\ntype: project\nstatus: 완료\n---\n# 이사\n",
  [`20.영역/업무일지/${d.getFullYear()}/${today}.md`]: "---\ntype: journal\n---\n# 오늘\n",
  "회의록.md": `---\ntype: meeting\ncreated: ${today}\n---\n# 회의록\n\n## 결정 사항\n\n예산은 그대로 간다\n이번 달 안에 마무리 ^decide\n\n- 다음 회의 일정 잡기\n`,
  "메모.md": "# 메모\n\n",
};
for (const [rel, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), text);
}
const read = (rel) => fs.readFileSync(path.join(VAULT, rel), "utf8");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 5);
  const shot = (n) => page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", `srb-${n}.png`) });

  // 1) Saved search: type, ☆, name, save; clear; click the chip to run it again.
  await page.keyboard.press("Control+Shift+f");
  await page.fill(".search-input", "status:진행");
  await page.click(".save-search");
  await page.fill('input[aria-label="검색 이름"]', "진행 중 프로젝트");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".saved-chip.on");
  await page.fill(".search-input", "");
  await page.click(".saved-run:text-is('진행 중 프로젝트')");
  await page.waitForTimeout(500);
  const hits = await page.$$eval(".results .r-title", (es) => es.map((e) => e.textContent));
  const cfg = JSON.parse(fs.readFileSync(path.join(VAULT, ".app", "config.json"), "utf8"));
  console.log("1 saved search:", await page.inputValue(".search-input"), JSON.stringify(hits), "| in config:", JSON.stringify(cfg.saved_searches.map((s) => s.name)));
  await shot("search");

  // 2) Weekly review from the palette.
  await page.keyboard.press("Control+p");
  await page.keyboard.type("주간 회고 묶음 만들기 (이번 주)");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".note-title >> text=/주간 회고/");
  const reviewPath = await page.evaluate(() => window.__notevine.getState().openPath);
  const review = read(reviewPath);
  console.log("2 review:", reviewPath, "| sections:", JSON.stringify(review.match(/^## .*/gm)));
  await shot("review");
  // Running it again opens the same note.
  await page.evaluate(() => window.__notevine.getState().openNote("메모.md"));
  await page.keyboard.press("Control+p");
  await page.keyboard.type("주간 회고 묶음 만들기 (이번 주)");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  console.log("2 again opens it:", (await page.evaluate(() => window.__notevine.getState().openPath)) === reviewPath);

  // 3) Block link: [[회의록#^ → pick a paragraph without an id → id added to 회의록.md.
  await page.evaluate(() => window.__notevine.getState().openNote("메모.md"));
  await page.waitForSelector(".note-title >> text=메모");
  if (await page.$(".note-view")) await page.keyboard.press("Control+e");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("[[회의록#");
  await page.waitForSelector(".cm-tooltip-autocomplete li");
  const headingsOffered = await page.$$eval(".cm-tooltip-autocomplete li", (ls) => ls.map((l) => l.textContent));
  console.log("3 headings:", JSON.stringify(headingsOffered));
  await page.keyboard.type("^");
  await page.waitForTimeout(400);
  const blocks = await page.$$eval(".cm-tooltip-autocomplete li", (ls) => ls.map((l) => l.textContent));
  console.log("3 blocks:", JSON.stringify(blocks));
  await page.click('.cm-tooltip-autocomplete li:has-text("다음 회의 일정 잡기")');
  await page.waitForTimeout(1500);
  const id = (/^- 다음 회의 일정 잡기 \^([a-z0-9]{6})$/m.exec(read("회의록.md")) ?? [])[1];
  const line = await page.evaluate(() => window.__notevine.getState().editorApi?.view?.state.doc.toString().split("\n").pop() ?? null);
  console.log("3 id added:", !!id, "| link:", line ?? (await page.textContent(".cm-content")).slice(-40));
  // An existing id is reused.
  await page.keyboard.press("End");
  await page.keyboard.type("\n[[회의록#^");
  await page.waitForSelector(".cm-tooltip-autocomplete li");
  await page.click('.cm-tooltip-autocomplete li:has-text("이번 달 안에 마무리")');
  await page.waitForTimeout(1500);
  console.log("3 reuses ^decide:", read("메모.md").includes("[[회의록#^decide]]"), "| file:", JSON.stringify(read("메모.md").slice(-60)));

  // 4) Follow the block link in read mode: it opens 회의록 at that item.
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  await page.click(`.note-view a.wikilink >> nth=0`);
  await page.waitForSelector(".note-title >> text=회의록");
  await page.waitForTimeout(500);
  const flashed = await page.$$eval(".block-flash", (es) => es.map((e) => e.textContent.trim()));
  const hiddenId = !(await page.textContent(".note-view")).includes("^decide");
  console.log("4 jumped to:", JSON.stringify(flashed), "| ids hidden:", hiddenId);
  await shot("block");

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
