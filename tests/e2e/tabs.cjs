// 탭 (FR-EDT-07): 지금 탭/새 탭에서 열기, 탭 전환·닫기·다시 열기, 탭마다 기록·커서, 다시 켜면 복원. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "tabs-" + Date.now());
const w = (rel, t) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), t);
};
const lines = (name) => [`# ${name}`, "", ...Array.from({ length: 80 }, (_, i) => `${name} 줄 ${i + 1}`)].join("\n\n");
w("가.md", lines("가") + "\n\n[[나]] · [[다]]\n");
w("나.md", lines("나"));
w("다.md", lines("다"));
w("라.md", "# 라\n\n지울 노트\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  const st = (fn, arg) => page.evaluate(fn, arg);
  const tabs = () => st(() => [...document.querySelectorAll(".tabbar .tab")].map((t) => (t.classList.contains("on") ? "*" : "") + t.textContent.replace("×", "")));
  const row = (name) => `.tree-row:has(.tree-label:text-is("${name}"))`;
  const editMode = async () => {
    if (await page.$(".note-view")) await page.keyboard.press("Control+e");
    await page.waitForSelector(".cm-host:not([hidden]) .cm-content");
  };

  // Plain click opens in the current tab; back goes to the note before.
  await page.click(row("가"));
  await page.waitForSelector(".note-title >> text=가");
  await editMode();
  await page.click(row("나"));
  await page.waitForSelector(".note-title >> text=나");
  console.log("1 plain clicks:", JSON.stringify(await tabs()));
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForSelector(".note-title >> text=가");
  console.log("2 Alt+← in the tab:", JSON.stringify(await tabs()));

  // Ctrl+click and middle click open new tabs.
  await page.click(row("나"), { modifiers: ["Control"] });
  await page.waitForSelector(".note-title >> text=나");
  await page.click(row("다"), { button: "middle" });
  await page.waitForSelector(".note-title >> text=다");
  console.log("3 Ctrl+click, middle click:", JSON.stringify(await tabs()));
  // Opening a note that already has a tab goes to that tab.
  await page.click(row("가"));
  await page.waitForSelector(".note-title >> text=가");
  console.log("4 open an already open note:", JSON.stringify(await tabs()));

  // Cursor and scroll are kept per tab; typing then switching saves the note.
  await editMode();
  await st(() =>
    window.__notevine.getState().editorApi.rewrite((text) => {
      const at = text.indexOf("가 줄 60");
      return { text: text.replace("가 줄 60", "가 줄 60 (고침)"), cursor: at };
    }),
  );
  await page.waitForTimeout(200);
  const top0 = await st(() => document.querySelector(".editor").scrollTop);
  await page.keyboard.press("Control+Tab");
  await page.waitForSelector(".note-title >> text=나");
  await page.waitForTimeout(600);
  console.log("5 saved on switch:", fs.readFileSync(path.join(VAULT, "가.md"), "utf8").includes("가 줄 60 (고침)"));
  await page.keyboard.press("Control+Shift+Tab");
  await page.waitForSelector(".note-title >> text=가");
  await page.waitForTimeout(400);
  const back = await st(() => {
    let line;
    window.__notevine.getState().editorApi.rewrite((text, cursor) => {
      line = text.slice(0, cursor).split("\n").pop() + text.slice(cursor).split("\n")[0];
      return { text, cursor };
    });
    return { line, top: document.querySelector(".editor").scrollTop };
  });
  console.log("6 cursor and scroll kept:", back.line, "| scroll", Math.round(top0), "→", Math.round(back.top));

  // Ctrl+W closes, Ctrl+Shift+T brings it back; the window stays.
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(300);
  console.log("7 Ctrl+W:", JSON.stringify(await tabs()));
  await page.keyboard.press("Control+Shift+T");
  await page.waitForSelector(".note-title >> text=가");
  console.log("8 Ctrl+Shift+T:", JSON.stringify(await tabs()));

  // Read mode: Ctrl+click on a link opens a new tab; middle click too.
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  await page.click(".note-view a.wikilink >> text=다", { modifiers: ["Control"] });
  await page.waitForTimeout(400);
  console.log("9 read-mode Ctrl+click (다 already open → its tab):", JSON.stringify(await tabs()));

  // Rename follows the tab, delete closes it.
  await st(() => window.__notevine.getState().openNote("라.md", undefined, undefined, { newTab: true }));
  await page.waitForSelector(".note-title >> text=라");
  await st(() => window.__notevine.getState().openNote("나.md"));
  await page.waitForSelector(".note-title >> text=나");
  await st(() => { void window.__notevine.getState().rename("다.md", "다다"); });
  // 가 links to 다, so the app asks whether to fix the link too.
  await page.click(".modal button.primary");
  await page.waitForTimeout(800);
  console.log("10 after rename 다 → 다다:", JSON.stringify(await tabs()));
  await st(() => window.__notevine.getState().remove("라.md"));
  await page.waitForTimeout(800);
  console.log("11 after deleting 라:", JSON.stringify(await tabs()));

  // × closes that tab.
  // The × shows on hover (and on the active tab).
  await page.hover(".tabbar .tab:has-text('다다')");
  await page.click(".tabbar .tab:has-text('다다') .tab-close");
  await page.waitForTimeout(300);
  console.log("12 × on 다다:", JSON.stringify(await tabs()));

  // Restart: the tabs come back.
  await page.click(row("다다"), { modifiers: ["Control"] });
  await page.waitForSelector(".note-title >> text=다다");
  await page.waitForTimeout(300);
  const before = await tabs();
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tabbar .tab");
  await page.waitForTimeout(500);
  console.log("13 restored after restart:", JSON.stringify(before), "→", JSON.stringify(await tabs()));
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "tabs.png") });

  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
