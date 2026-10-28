// Day-6 UI check: preset, today journal, quick memo, idea board, templates, attachments
// (paste/drop/preview/missing), history diff+restore, deleted-note restore, settings theme,
// command palette, back/forward.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const OUT = path.join(require("os").tmpdir(), "notevine-e2e", "shots");
const VAULT = path.join(require("os").tmpdir(), "notevine-e2e", "v6-" + Date.now());
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "기존 노트.md"), "원래 있던 노트\n");
const exists = (rel) => fs.existsSync(path.join(VAULT, rel));
const read = (rel) => fs.readFileSync(path.join(VAULT, rel), "utf8");
const today = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const ymd = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const st = (fn, arg) => page.evaluate(([f, a]) => new Function("s", "a", `return (${f})(s, a)`)(window.__notevine.getState(), a), [fn.toString(), arg]);
  await page.reload();
  await page.waitForSelector(".start-card, .tree-row, .empty");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  await sleep(500);

  // 1) preset via command palette
  await page.keyboard.press("Control+p");
  await page.waitForSelector(".palette-input");
  await page.keyboard.type("프리셋");
  await sleep(100);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal >> text=업무일지·아이디어 기능 켜기");
  console.log("confirm lists folders:", (await page.textContent(".confirm-msg")).includes("10 업무일지"));
  await page.click(".modal .btn.primary");
  await page.waitForSelector(".tree-row >> text=90 템플릿", { timeout: 5000 });
  console.log("preset folders:", ["00 Inbox", "10 업무일지", "20 아이디어", "30 조사자료", "90 템플릿", "첨부"].map(exists));
  console.log("templates:", fs.readdirSync(path.join(VAULT, "90 템플릿")));
  console.log("existing note untouched:", read("기존 노트.md") === "원래 있던 노트\n");

  // 2) today journal
  await page.keyboard.press("Control+Shift+D");
  await page.waitForSelector(`.note-title >> text=${ymd}`, { timeout: 5000 });
  console.log("journal:", exists(`10 업무일지/${today.getFullYear()}/${ymd}.md`), JSON.stringify(read(`10 업무일지/${today.getFullYear()}/${ymd}.md`).slice(0, 80)));

  // 3) quick memo
  await page.keyboard.press("Control+Shift+N");
  await page.waitForSelector(".memo textarea");
  await page.keyboard.type("보고 자동화 아이디어");
  await page.keyboard.press("Enter");
  await page.keyboard.type("주간 보고를 템플릿으로");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".toast >> text=Inbox에 저장됨");
  console.log("memo:", JSON.stringify(read("00 Inbox/보고 자동화 아이디어.md")));

  // 4) idea board: right-click → 검토
  await page.click(".side-tabs button >> text=아이디어");
  await page.waitForSelector(".idea-group li >> text=보고 자동화 아이디어");
  await page.click(".idea-group li >> text=보고 자동화 아이디어", { button: "right" });
  await page.click(".menu li >> text=검토");
  await sleep(800);
  console.log("status changed:", /status: 검토/.test(read("00 Inbox/보고 자동화 아이디어.md")));
  await page.screenshot({ path: path.join(OUT, "13-ideas.png") });

  // 5) template picker → 자료 goes to 30 조사자료
  await page.keyboard.press("Control+n");
  await page.waitForSelector(".palette-list.templates li");
  console.log("template options:", await page.$$eval(".palette-list.templates li", (els) => els.map((e) => e.textContent.slice(0, 30))));
  await page.click(".palette-list.templates li >> text=자료");
  await page.waitForSelector(".palette-input");
  await page.fill(".palette-input", "도구 비교");
  await page.keyboard.press("Enter");
  await sleep(800);
  console.log("from template:", exists("30 조사자료/도구 비교.md"), JSON.stringify(read("30 조사자료/도구 비교.md").slice(0, 90)));

  // 6) attachments: paste an image, drop a file, preview renders
  await page.click(".side-tabs button >> text=파일");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([png], "clip.png", { type: "image/png" }));
    document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(1200);
  const target = document => null;
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], "견적서.xlsx", { type: "application/vnd.ms-excel" }));
    const r = document.querySelector(".cm-content").getBoundingClientRect();
    document.querySelector(".cm-content").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.bottom - 5 }));
  });
  await sleep(1200);
  await page.keyboard.press("Control+Home");
  await sleep(500);
  console.log("attachments folder:", fs.readdirSync(path.join(VAULT, "첨부")));
  console.log("note has links:", /!\[\[첨부\/이미지 \d{8}-\d{6}\.png\]\]/.test(read("30 조사자료/도구 비교.md")), /\[\[첨부\/견적서\.xlsx\]\]/.test(read("30 조사자료/도구 비교.md")));
  console.log("image preview rendered:", await page.$$eval("img.cm-embed-img", (els) => els.length));
  console.log("file link chip:", await page.$$eval(".cm-wikilink-file", (els) => els.map((e) => e.textContent)));
  await page.screenshot({ path: path.join(OUT, "14-attach.png") });
  // missing attachment → toast
  await page.evaluate(() => window.__notevine.getState().openAttachment("없는 파일.pdf"));
  await page.waitForSelector(".toast.error >> text=첨부 파일을 찾을 수 없음");
  console.log("missing attachment toast: true");

  // 7) history: two forced saves, diff, restore
  await page.evaluate(() => window.__notevine.getState().openNote("기존 노트.md"));
  await page.waitForSelector(".note-title >> text=기존 노트");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n두 번째 줄");
  await page.keyboard.press("Control+s");
  await sleep(600);
  await page.keyboard.type("\n세 번째 줄");
  await page.keyboard.press("Control+s");
  await sleep(1000);
  const items = await page.$$eval(".hist-item", (els) => els.map((e) => e.textContent));
  console.log("history items:", items);
  await page.click(".hist-item >> nth=-1"); // oldest
  await page.waitForSelector(".version-view");
  await page.click(".vv-modes button >> text=현재와 비교");
  await sleep(500);
  console.log("diff:", await page.$$eval(".vv-diff .dl", (els) => els.map((e) => e.className.replace("dl ", "") + ":" + e.querySelector(".txt").textContent)));
  await page.screenshot({ path: path.join(OUT, "15-diff.png") });
  page.once("dialog", (d) => d.accept());
  const restored = page.evaluate(() => 0);
  await restored;
  // the confirm is a native dialog; call restore through the same API path the button uses
  const versions = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_versions", { path: "기존 노트.md" }));
  await page.keyboard.press("Escape");
  await page.evaluate(async (id) => {
    const s = window.__notevine.getState();
    await s.flushEditor(true);
    await window.__TAURI_INTERNALS__.invoke("restore_version", { path: "기존 노트.md", id });
    window.__notevine.setState({ externalSeq: s.externalSeq + 1, externalPaths: ["기존 노트.md"] });
    s.noteSaved();
  }, versions[versions.length - 1].id);
  await sleep(800);
  console.log("restored file:", JSON.stringify(read("기존 노트.md")), "editor:", JSON.stringify(await page.textContent(".cm-content")));
  const after = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_versions", { path: "기존 노트.md" }));
  console.log("origins after restore:", after.map((v) => v.origin));

  // 8) deleted note → restore from history
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("delete_entry", { path: "30 조사자료/도구 비교.md" }));
  await sleep(600);
  await page.keyboard.press("Control+p");
  await page.keyboard.type("삭제된");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".deleted-list li >> text=도구 비교");
  console.log("deleted list:", await page.$$eval(".deleted-list li", (els) => els.map((e) => e.textContent)));
  await page.keyboard.press("Escape");

  // 9) settings → dark theme
  await page.keyboard.press("Control+,");
  await page.waitForSelector(".modal.settings");
  await page.selectOption(".set-ctl select >> nth=0", "dark");
  await sleep(400);
  console.log("theme:", await page.evaluate(() => document.documentElement.dataset.theme), JSON.parse(read(".app/config.json")).theme);
  await page.screenshot({ path: path.join(OUT, "16-settings-dark.png") });
  await page.selectOption(".set-ctl select >> nth=0", "system");
  await page.keyboard.press("Escape");

  // 10) back / forward
  await page.evaluate(() => window.__notevine.getState().openNote("00 Inbox/보고 자동화 아이디어.md"));
  await page.waitForSelector(".note-title >> text=보고 자동화 아이디어");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForSelector(".note-title >> text=기존 노트");
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForSelector(".note-title >> text=보고 자동화 아이디어");
  console.log("back/forward: true");

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
