// 읽기 모드의 노트 임베드 ![[노트]] · ![[노트#제목]] (FR-LNK-07). AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "embed-" + Date.now());
const w = (rel, t) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), t);
};
w(
  "모음.md",
  [
    "# 모음",
    "",
    "- [ ] 내 할 일",
    "",
    "![[회의록]]",
    "",
    "![[회의록#결정 사항]]",
    "",
    "![[없는 노트]]",
    "",
    "![[회의록#없는 제목]]",
    "",
    "![[모음]]",
    "",
    "![[가]]",
    "",
    "![[견적서.xlsx]]",
  ].join("\n"),
);
w(
  "회의록.md",
  ["---", "tags: [회의]", "---", "# 회의록", "", "참석: 나", "", "## 결정 사항", "", "- [ ] 회의록 할 일", "- 수식 $x^2$", "", "### 세부", "", "[[업무]]로 이어짐", "", "## 다음 안건", "", "- 다음"].join("\n"),
);
w("업무.md", "# 업무\n");
w("가.md", "# 가\n\n![[나]]\n");
w("나.md", "# 나\n\n![[가]]\n");
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
  const st = (fn) => page.evaluate(fn);

  await page.click(".tree-row >> text=모음");
  await page.waitForSelector(".note-title >> text=모음");
  if (!(await page.$(".note-view"))) await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view .note-embed-body");
  await page.waitForSelector(".note-view .note-embed-body .katex", { timeout: 10000 });
  await page.waitForTimeout(500);

  const r = await st(() => {
    const el = document.querySelector(".note-view");
    const spans = [...el.querySelectorAll(":scope span.note-embed")].filter((s) => !s.parentElement.closest(".note-embed-body"));
    const body = (s) => s.querySelector(":scope > .note-embed-body");
    const note = (s) => s.querySelector(":scope > .note-embed-note")?.textContent ?? null;
    return {
      count: spans.length,
      whole: {
        hasTitle: !!body(spans[0])?.querySelector("h1"),
        frontmatterHidden: !body(spans[0])?.textContent.includes("tags:"),
        hasNext: body(spans[0])?.textContent.includes("다음 안건"),
      },
      section: {
        first: body(spans[1])?.firstElementChild?.textContent,
        hasSub: body(spans[1])?.textContent.includes("세부"),
        noNext: !body(spans[1])?.textContent.includes("다음 안건"),
      },
      missingNote: { body: !!body(spans[2]), unresolved: spans[2].querySelector(":scope > a").classList.contains("unresolved") },
      missingHeading: note(spans[3]),
      self: note(spans[4]),
      loop: (() => {
        const ga = body(spans[5]);
        const na = ga?.querySelector("span.note-embed > .note-embed-body");
        return { ga: !!ga, na: !!na, msg: na?.querySelector(".note-embed-note")?.textContent ?? null };
      })(),
      fileStaysLink: !el.querySelector('[data-note-embed="견적서.xlsx"]') && !!el.querySelector('a[data-target="견적서.xlsx"]'),
      embeddedTaskDisabled: body(spans[0])?.querySelector("input.task")?.disabled,
    };
  });
  console.log("embeds:", JSON.stringify(r, null, 1));
  await page.screenshot({ path: path.join(OUT, "embed-read.png") });

  // The note's own task toggles, not the embedded one.
  await page.click(".note-view > ul input.task");
  await page.waitForTimeout(1500);
  console.log("own task toggled:", (await st(() => window.__notevine.getState().docText)).includes("- [x] 내 할 일"));
  console.log("회의록 untouched:", !fs.readFileSync(path.join(VAULT, "회의록.md"), "utf8").includes("[x]"));

  // A link inside an embed opens its note.
  await page.click(".note-embed-body a.wikilink >> text=업무");
  await page.waitForSelector(".note-title >> text=업무");
  console.log("link in embed opens:", await st(() => window.__notevine.getState().openPath));

  // Editing the embedded note shows in the embed when coming back.
  await page.evaluate(() => window.__notevine.getState().openNote("회의록.md"));
  await page.waitForSelector(".note-title >> text=회의록");
  if (await page.$(".note-view")) await page.keyboard.press("Control+e");
  await page.waitForSelector(".cm-content");
  await page.evaluate(() =>
    window.__notevine.getState().editorApi.rewrite((text, cursor) => ({ text: text.replace("참석: 나", "참석: 나, 너"), cursor })),
  );
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.__notevine.getState().openNote("모음.md"));
  await page.waitForSelector(".note-title >> text=모음");
  if (!(await page.$(".note-view"))) await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view .note-embed-body");
  await page.waitForTimeout(500);
  console.log("embed shows the edit:", await st(() => document.querySelector(".note-embed-body").textContent.includes("참석: 나, 너")));

  console.log("remote requests:", remote);
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
