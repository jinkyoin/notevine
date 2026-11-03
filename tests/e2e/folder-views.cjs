// 폴더 보기 (FR-PRS-08·FR-UI-05): 보드 끌어 놓기로 status 바꾸기, 캘린더 날짜 배치·업무일지 열기, 그래프 노드·링크·클릭. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "views-" + Date.now());
const P = path.join(VAULT, "10.프로젝트");
fs.mkdirSync(P, { recursive: true });
const now = new Date();
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
fs.writeFileSync(path.join(P, "웹 개편.md"), `---\nstatus: 진행\ndeadline: ${ym}-20\n---\n# 웹 개편\n\n[[이사]] 와 [[보고서]]\n`);
fs.writeFileSync(path.join(P, "이사.md"), `---\nstatus: 아이디어\ncreated: ${ym}-03\n---\n[[웹 개편]]\n`);
fs.writeFileSync(path.join(P, "보고서.md"), `---\nstatus: 완료\ncreated: ${ym}-03\n---\n본문\n`);
fs.writeFileSync(path.join(P, "외톨이.md"), "링크 없음\n");
const read = (n) => fs.readFileSync(path.join(P, n), "utf8");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  const row = (name) => `.tree-row:has(.tree-label:text-is("${name}"))`;
  const shot = (n) => page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", `views-${n}.png`) });

  // 1) Board from the folder menu.
  await page.click(row("10.프로젝트"), { button: "right" });
  await page.click('.menu .menu-row-btns button:text-is("보드")');
  await page.waitForSelector(".board-col");
  const cols = await page.$$eval(".board-col h4", (hs) => hs.map((h) => h.textContent.trim()));
  console.log("1 columns:", JSON.stringify(cols));
  await shot("board");

  // 2) Drag 이사 to 검토: its file changes.
  await page.dragAndDrop('.card:has-text("이사")', '.board-col:has(h4:text-matches("^검토"))');
  await page.waitForTimeout(800);
  console.log("2 dragged:", /status: 검토/.test(read("이사.md")), "| card moved:", !!(await page.$('.board-col:has(h4:text-matches("^검토")) .card:has-text("이사")')));

  // 3) Calendar: notes by created, then by deadline.
  await page.click('.fb-mode button:text-is("캘린더")');
  await page.waitForSelector(".cal-grid");
  const on3 = await page.$$eval(`.cal-day[data-day="${ym}-03"] li`, (ls) => ls.map((l) => l.textContent));
  console.log("3 created on 3rd:", JSON.stringify(on3.sort()));
  await page.selectOption(".calendar select", "deadline");
  const on20 = await page.$$eval(`.cal-day[data-day="${ym}-20"] li`, (ls) => ls.map((l) => l.textContent));
  console.log("3 deadline on 20th:", JSON.stringify(on20));
  await shot("calendar");

  // 4) Graph: 4 nodes, 3 links; hiding unlinked notes drops one.
  await page.click('.fb-mode button:text-is("그래프")');
  await page.waitForSelector(".graph-node");
  await page.waitForTimeout(1500);
  console.log("4 graph:", (await page.$$(".graph-node")).length, "nodes", (await page.$$(".graph-edges line")).length, "links");
  await shot("graph");
  await page.check('.graph input[type="checkbox"]');
  await page.waitForTimeout(300);
  console.log("4 linked only:", (await page.$$(".graph-node")).length);

  // 5) Clicking a node opens the note and closes the view.
  await page.click('.graph-node:has(title:text-is("10.프로젝트/보고서.md")) circle');
  await page.waitForSelector(".note-title >> text=보고서");
  console.log("5 opened:", await page.$eval(".note-title", (e) => e.textContent), "| view closed:", !(await page.$(".folder-table")));

  // 6) Whole-vault calendar from the palette, then today's journal from a day.
  await page.keyboard.press("Control+p");
  await page.keyboard.type("전체 노트 캘린더");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".cal-grid");
  console.log("6 whole vault:", await page.$eval(".folder-table-head h2", (e) => e.textContent));

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
