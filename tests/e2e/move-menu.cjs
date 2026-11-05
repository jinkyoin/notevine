// 파일 탐색기 우클릭 메뉴의 '다른 폴더로 이동'. AI 호출 없음. 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "move-" + Date.now());
fs.mkdirSync(path.join(VAULT, "자료", "하위"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "보관"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "옮길 노트.md"), "# 옮길 노트\n");
fs.writeFileSync(path.join(VAULT, "자료", "안쪽 노트.md"), "# 안쪽\n");
fs.writeFileSync(path.join(VAULT, "링크된 노트.md"), "# 링크된\n");
fs.writeFileSync(path.join(VAULT, "링크하는 노트.md"), "본문\n");
const exists = (...p) => fs.existsSync(path.join(VAULT, ...p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 3);
  await page.waitForSelector(".tree-row");

  const row = (name) => page.locator(".tree-row", { hasText: name }).first();
  const openPicker = async (name) => {
    await row(name).click({ button: "right" });
    await page.getByText("다른 폴더로 이동…", { exact: true }).click();
    await page.waitForSelector(".palette .palette-input");
  };
  const options = () => page.locator(".palette-list li").allInnerTexts();

  // A note: every folder but where it is, then a search and Enter.
  await openPicker("옮길 노트");
  let o = await options();
  assert.deepStrictEqual(o, ["보관", "자료", "자료/하위"], "options for a note at the top: " + o);
  await page.keyboard.type("하위");
  assert.deepStrictEqual(await options(), ["자료/하위"]);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".palette"));
  await sleep(600);
  assert.ok(exists("자료", "하위", "옮길 노트.md") && !exists("옮길 노트.md"), "the note didn't move");
  console.log("note moved by search and Enter: ok");

  // A folder: not into itself or below, and the top of the vault is offered.
  await page.evaluate(() => window.__notevine.getState().toggleFolder("자료", true));
  await sleep(200);
  await openPicker("하위");
  o = await options();
  assert.ok(o.includes("노트 폴더 맨 위") && o.includes("보관"), "options for a folder: " + o);
  assert.ok(!o.includes("자료") && !o.includes("자료/하위"), "offered its own place or itself: " + o);
  await page.locator(".palette-list li", { hasText: "보관" }).click();
  await page.waitForFunction(() => !document.querySelector(".palette"));
  await sleep(600);
  assert.ok(exists("보관", "하위", "옮길 노트.md"), "the folder didn't move with its note");
  console.log("folder moved by clicking: ok");

  // Esc moves nothing.
  await openPicker("링크하는 노트");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".palette"));
  assert.ok(exists("링크하는 노트.md"), "Esc moved it");
  console.log("Esc: ok");

  assert.deepStrictEqual(errors, [], "page errors");
  console.log("ALL PASSED");
  await browser.close();
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
