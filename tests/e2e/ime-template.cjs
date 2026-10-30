// 템플릿 제목 사이에 한글(IME)로 쓸 때 아래 제목 줄이 끌려 올라오지 않는지. AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "ime-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
const NOTE = [
  "---",
  "type: idea",
  "status: 아이디어",
  "tags: []",
  "created: 2026-10-30",
  "---",
  "",
  "## 아이디어",
  "",
  "## 배경·문제",
  "",
  "## 기대 효과",
  "",
  "## 다음 단계",
  "",
  "- [ ] ",
  "",
].join("\n");
fs.writeFileSync(path.join(VAULT, "블로그 주제.md"), NOTE);

/** Types Hangul the way an IME does: each syllable is composed jamo by jamo, then committed. */
async function typeKorean(cdp, page, syllables) {
  for (const steps of syllables) {
    for (const s of steps) {
      await cdp.send("Input.imeSetComposition", { text: s, selectionStart: s.length, selectionEnd: s.length });
      await page.waitForTimeout(40);
    }
    await cdp.send("Input.insertText", { text: steps[steps.length - 1] });
    await page.waitForTimeout(40);
  }
}

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.evaluate(() => window.__notevine.getState().openNote("블로그 주제.md"));
  if (await page.waitForSelector(".note-view", { timeout: 1500 }).catch(() => null)) await page.keyboard.press("Control+e");
  await page.waitForSelector(".cm-host:not([hidden]) .cm-content");
  const cdp = await page.context().newCDPSession(page);

  // Cursor on the empty line under "## 아이디어", as after clicking there.
  await page.evaluate(() =>
    window.__notevine.getState().editorApi.rewrite((text) => ({ text, cursor: text.indexOf("## 아이디어\n") + "## 아이디어\n".length })),
  );
  await page.click(".cm-content"); // focus without moving: re-place the cursor after
  await page.evaluate(() =>
    window.__notevine.getState().editorApi.rewrite((text) => ({ text, cursor: text.indexOf("## 아이디어\n") + "## 아이디어\n".length })),
  );
  await page.keyboard.type("- Para ");
  // 공식 문제제기
  await typeKorean(cdp, page, [
    ["ㄱ", "고", "공"],
    ["ㅅ", "시", "식"],
  ]);
  await page.keyboard.type(" ");
  await typeKorean(cdp, page, [
    ["ㅁ", "무", "문"],
    ["ㅈ", "제"],
    ["ㅈ", "제"],
    ["ㄱ", "기"],
  ]);
  // Enter, then more Korean on the next line (the list continues).
  await page.keyboard.press("Enter");
  await typeKorean(cdp, page, [
    ["ㄷ", "다"],
    ["ㅇ", "으", "음"],
  ]);
  // Then under a heading further down.
  await page.evaluate(() =>
    window.__notevine.getState().editorApi.rewrite((text) => ({ text, cursor: text.indexOf("## 기대 효과\n") + "## 기대 효과\n".length })),
  );
  await typeKorean(cdp, page, [
    ["ㅎ", "효"],
    ["ㄱ", "과"],
  ]);

  // Read what autosave wrote, without touching the editor.
  await page.waitForTimeout(2000);
  const text = fs.readFileSync(path.join(VAULT, "블로그 주제.md"), "utf8");
  const body = text.slice(text.indexOf("## 아이디어"));
  console.log("body:\n" + body);
  const expected = "## 아이디어\n- Para 공식 문제제기\n- 다음\n## 배경·문제\n\n## 기대 효과\n효과\n## 다음 단계\n\n- [ ] \n";
  console.log("headings intact:", ["## 배경·문제", "## 기대 효과", "## 다음 단계"].every((h) => body.includes("\n" + h + "\n")));
  console.log("exactly as typed:", body === expected);
  await page.screenshot({ path: path.join(os.tmpdir(), "notevine-e2e", "ime-template.png") });
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
