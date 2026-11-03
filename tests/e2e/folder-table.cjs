// 속성 표 보기 (FR-PRP-05): 폴더 우클릭 '보기: 표', 열·정렬, 행을 눌러 노트 열기, Esc로 닫기. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "table-" + Date.now());
const w = (rel, t) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), t);
};
w("프로젝트/홈페이지 개편/홈페이지 개편.md", "---\ntype: project\nstatus: 진행\ndeadline: 2026-12-15\n---\n# 홈페이지 개편\n");
w("프로젝트/이사/이사.md", "---\ntype: project\nstatus: 계획\ndeadline: 2026-11-20\ntags: [집, 가족]\n---\n# 이사\n");
w("프로젝트/책 읽기.md", "---\ntype: project\nstatus: 완료\n---\n");
w("프로젝트/메모.md", "속성 없는 노트\n");
w("다른 노트.md", "# 다른\n");

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
  const grid = () =>
    page.evaluate(() => ({
      head: [...document.querySelectorAll(".folder-table th")].map((t) => t.textContent.trim()),
      rows: [...document.querySelectorAll(".folder-table tbody tr")].map((r) => [...r.cells].map((c) => c.textContent.trim()).slice(0, 4).join(" | ")),
    }));

  // A note is open first; the table takes its place, then gives it back.
  await page.click(row("다른 노트"));
  await page.waitForSelector(".note-title >> text=다른 노트");
  await page.click(row("프로젝트"), { button: "right" });
  await page.click('.menu .menu-row-btns button:text-is("표")');
  await page.waitForSelector(".folder-table tbody tr");
  console.log("1 table:", JSON.stringify(await grid(), null, 1));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "folder-table.png") });

  await page.click('.folder-table th button:has-text("deadline")');
  console.log("2 by deadline:", JSON.stringify((await grid()).rows.map((r) => r.split(" | ")[0])));
  await page.click('.folder-table th button:has-text("deadline")');
  console.log("  reversed:", JSON.stringify((await grid()).rows.map((r) => r.split(" | ")[0])));

  // Saving a note refreshes the table.
  fs.writeFileSync(path.join(VAULT, "프로젝트/메모.md"), "---\nstatus: 보류\n---\n");
  await page.evaluate(() => window.__notevine.getState().refreshTree());
  await page.waitForTimeout(1500);
  console.log("3 after an outside change:", JSON.stringify((await grid()).rows.find((r) => r.startsWith("메모"))));

  await page.keyboard.press("Escape");
  await page.waitForSelector(".note-title >> text=다른 노트");
  console.log("4 Esc back to the note:", await page.evaluate(() => window.__notevine.getState().openPath));

  await page.keyboard.press("Control+p");
  await page.keyboard.type("표로 보기");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".folder-table");
  console.log("5 palette opens:", await page.textContent(".folder-table-head h2"));
  await page.keyboard.press("Escape");

  await page.click(row("프로젝트"), { button: "right" });
  await page.click('.menu .menu-row-btns button:text-is("표")');
  await page.waitForSelector(".folder-table tbody tr");
  await page.click('.folder-table tbody tr:has-text("이사")');
  await page.waitForSelector(".note-title >> text=이사");
  console.log("6 row click opens:", await page.evaluate(() => window.__notevine.getState().openPath), "| table gone:", !(await page.$(".folder-table")));

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
