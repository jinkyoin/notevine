// 서식 막대와 읽기 모드 (AI 호출 없음).
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "format-" + Date.now());
const w = (rel, t) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), t);
};
w("회의록.md", "# 회의록\n");
// 1x1 png
w("첨부/점.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
w(
  "샘플.md",
  [
    "---",
    "tags: [업무]",
    "---",
    "# 주간 정리",
    "",
    "이번 주는 **배포**와 *회고*, ~~취소된 일~~, ==중요한 결정==, `npm run build` 정리.",
    "",
    "- [ ] 할 일 하나",
    "- [x] 끝낸 일",
    "",
    "> 인용문",
    "",
    "| 항목 | 상태 |",
    "| --- | --- |",
    "| 배포 | 완료 |",
    "",
    "관련: [[회의록]], [[없는 노트]], [공식 문서](https://example.com) #업무/기획",
    "",
    "![[점.png]] ![웹 그림](https://example.com/a.png)",
    "",
    "```js",
    "const x = 1; // [[링크 아님]]",
    "```",
    "",
  ].join("\n"),
);
const OUT = path.join(os.tmpdir(), "notevine-e2e");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
  const errors = [];
  const remote = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => /^https?:\/\/(?!localhost|127\.0\.0\.1|asset\.localhost|ipc\.localhost)/.test(r.url()) && remote.push(r.url()));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row");
  // The editor publishes its text to the store 250 ms after a change.
  const doc = async () => {
    await page.waitForTimeout(400);
    return page.evaluate(() => window.__notevine.getState().docText);
  };

  // ---- toolbar on a fresh note ----
  await page.click(".tree-row >> text=회의록");
  await page.waitForSelector(".format-bar");
  console.log("buttons:", await page.$$eval(".fb-btn", (bs) => bs.map((b) => b.getAttribute("aria-label")).join(" · ")));
  await page.click(".cm-line >> nth=0");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("결정 사항");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.click('.fb-btn[aria-label="굵게"]');
  await page.click('.fb-btn[aria-label="번호 목록"]');
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("다음 할 일");
  await page.click('.fb-btn[aria-label="체크리스트"]');
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("중요");
  await page.keyboard.press("Control+Shift+h");
  await page.click('.fb-btn[aria-label="제목 2"]');
  console.log("after toolbar:\n" + (await doc()));
  await page.keyboard.press("Control+z");
  console.log("undo once removes heading:", !(await doc()).includes("## "));

  // ---- text / background color ----
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("빨간 글씨 노란 바탕");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.click('.fb-btn[aria-label="배경색"]');
  await page.waitForSelector(".fb-palette");
  await page.screenshot({ path: path.join(OUT, "palette.png"), clip: { x: 260, y: 40, width: 720, height: 260 } });
  await page.click('.fb-swatch[aria-label="배경색: 노랑"]');
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.click('.fb-btn[aria-label="글자 색"]');
  await page.click('.fb-swatch[aria-label="글자 색: 빨강"]');
  const line = (await doc()).split("\n").pop();
  console.log("colored line:", line);
  // move the cursor away: tags hide, colors stay
  await page.click(".cm-line >> nth=0");
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => {
    const l = [...document.querySelectorAll(".cm-line")].pop();
    return {
      text: l.textContent,
      colors: [...l.querySelectorAll("[style]")].map((e) => e.getAttribute("style")),
    };
  });
  console.log("editor shows:", JSON.stringify(shown));
  await page.screenshot({ path: path.join(OUT, "colors-edit.png"), clip: { x: 260, y: 40, width: 720, height: 300 } });
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  console.log(
    "read view colors:",
    await page.$$eval(".note-view span[style]", (s) => s.map((e) => `${e.textContent} → ${e.getAttribute("style")}`)),
  );
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".cm-host:not([hidden])");
  // remove the text color again
  // The raw line wraps, so Home would only reach the wrapped row: select the line by triple-click.
  await page.click(".cm-line >> nth=-1", { clickCount: 3 });
  await page.click('.fb-btn[aria-label="글자 색"]');
  await page.click(".fb-swatch-none");
  console.log("color removed:", (await doc()).split("\n").pop());

  // ---- read mode ----
  await page.click(".tree-row >> text=샘플");
  await page.waitForSelector(".cm-content");
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  await page.waitForTimeout(500);
  const v = await page.evaluate(() => {
    const el = document.querySelector(".note-view");
    const q = (s) => el.querySelectorAll(s).length;
    return {
      editorHidden: document.querySelector(".cm-host").hidden,
      toolbarDisabled: [...document.querySelectorAll(".fb-btn")].every((b) => b.disabled),
      h1: q("h1"), strong: q("strong"), em: q("em"), del: q("del"), mark: q("mark"), code: q("code"), tasks: q("input.task"),
      table: q("table"), quote: q("blockquote"), frontmatterShown: el.textContent.includes("tags:"),
      unresolved: [...el.querySelectorAll("a.wikilink.unresolved")].map((a) => a.textContent),
      tag: el.querySelector(".tag")?.textContent,
      imgSrc: el.querySelector("img")?.getAttribute("src")?.slice(0, 30),
      webImage: el.querySelector('a.external[data-url$="a.png"]')?.textContent,
      codeLink: q("pre a"),
    };
  });
  console.log("read view:", JSON.stringify(v));
  await page.screenshot({ path: path.join(OUT, "read-mode.png") });

  // task box toggles the source
  await page.click(".note-view input.task >> nth=0");
  await page.waitForTimeout(200);
  console.log("task toggled in source:", (await doc()).includes("- [x] 할 일 하나"), "box checked:", await page.$eval(".note-view input.task", (i) => i.checked));

  // external link must not navigate the app
  const before = page.url();
  await page.click(".note-view a.external >> text=공식 문서");
  await page.waitForTimeout(300);
  console.log("app stayed:", page.url() === before);

  // wiki link opens the note (staying in read mode)
  await page.click(".note-view a.wikilink >> text=회의록");
  await page.waitForSelector(".note-title >> text=회의록");
  console.log("followed link, read mode kept:", !!(await page.$(".note-view")));

  await page.keyboard.press("Control+e");
  await page.waitForSelector(".cm-host:not([hidden])");
  console.log("back to edit, focused:", await page.evaluate(() => !!document.querySelector(".cm-focused")));

  await page.click(".tree-row >> text=샘플");
  await page.waitForSelector(".cm-content");
  await page.click('.fb-mode button >> text=읽기');
  await page.waitForSelector(".note-view");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "read-mode-dark.png") });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.click('.fb-mode button >> text=편집');

  console.log("remote requests:", remote);
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
