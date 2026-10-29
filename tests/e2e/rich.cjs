// 읽기 모드의 수식·Mermaid(FR-EDT-08), 태그 클릭 검색, [[노트#제목]] 이동, 템플릿 삽입(Ctrl+T). AI 호출 없음.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "rich-" + Date.now());
const w = (rel, t) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), t);
};
const filler = Array.from({ length: 60 }, (_, i) => `채움 줄 ${i + 1}`).join("\n\n");
w(
  "수식.md",
  [
    "# 수식과 그림",
    "",
    "인라인 $E=mc^2$ 과 돈 $5 and $10, 그리고 \\$3.",
    "",
    "$$",
    "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
    "$$",
    "",
    "```mermaid",
    "graph TD",
    "  A[시작] --> B{확인}",
    "  B -->|예| C[끝]",
    "```",
    "",
    "```mermaid",
    "이건 잘못된 다이어그램 -->",
    "```",
    "",
    "태그 #업무/기획 · [[회의록#결정 사항]] · [[#아래 제목]] · [[회의록#없는 제목]]",
    "",
    filler,
    "",
    "## 아래 제목",
    "",
    "끝",
  ].join("\n"),
);
w("회의록.md", ["# 회의록", "", filler, "", "## 결정 사항", "", "- 하나", ""].join("\n"));
w("업무.md", "# 업무\n\n#업무/기획 관련 노트\n");
w("90 템플릿/짧은 양식.md", "---\nkind: memo\n---\n\n## {{title}} 메모\n");
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

  // ---- math and mermaid ----
  await page.click(".tree-row >> text=수식");
  await page.waitForSelector(".cm-content");
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  await page.waitForSelector(".note-view .katex", { timeout: 10000 });
  await page.waitForSelector(".note-view .mermaid-block.drawn svg", { timeout: 15000 });
  await page.waitForSelector(".note-view .mermaid-error", { timeout: 15000 });
  const r = await st(() => {
    const el = document.querySelector(".note-view");
    return {
      katex: el.querySelectorAll(".katex").length,
      display: el.querySelectorAll(".katex-display").length,
      moneyKeptAsText: el.textContent.includes("$5 and $10"),
      escapedDollar: el.textContent.includes("그리고 $3."),
      svg: el.querySelectorAll(".mermaid-block.drawn svg").length,
      svgText: el.querySelector(".mermaid-block.drawn svg")?.textContent.includes("시작"),
      badShownAsCode: !!el.querySelectorAll(".mermaid-block")[1]?.querySelector("pre code"),
      error: el.querySelector(".mermaid-error")?.textContent.slice(0, 40),
      scripts: el.querySelectorAll("script").length,
    };
  });
  console.log("rich:", JSON.stringify(r));
  await page.screenshot({ path: path.join(OUT, "rich-read.png") });

  // ---- [[#아래 제목]] in the same note, read mode scrolls ----
  const top0 = await st(() => document.querySelector(".note-view h2")?.getBoundingClientRect().top);
  await page.click(".note-view a.wikilink >> text=아래 제목");
  await page.waitForTimeout(400);
  const top1 = await st(() => document.querySelector(".note-view h2")?.getBoundingClientRect().top);
  console.log("same-note heading scrolled into view:", top0 > 800 && top1 >= 0 && top1 < 400, Math.round(top0), "→", Math.round(top1));

  // ---- [[회의록#결정 사항]] opens the other note at the heading ----
  await page.click(".note-view a.wikilink >> text=회의록 › 결정 사항");
  await page.waitForSelector(".note-title >> text=회의록");
  await page.waitForTimeout(600);
  const jump = await st(() => {
    const s = window.__notevine.getState();
    const h = [...document.querySelectorAll(".note-view h2")].find((e) => e.textContent === "결정 사항");
    return { line: s.jumpLine, heading: s.jumpHeading, headingTop: h ? Math.round(h.getBoundingClientRect().top) : null };
  });
  console.log("other-note heading:", JSON.stringify(jump));

  // edit mode: the cursor sits on the heading line
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".cm-host:not([hidden])");
  await page.waitForTimeout(300);
  // Read the cursor through rewrite() without changing the text.
  console.log(
    "edit cursor line text:",
    await st(() => {
      let line;
      window.__notevine.getState().editorApi.rewrite((text, cursor) => {
        const n = text.slice(0, cursor).split("\n").length;
        line = n + ": " + text.split("\n")[n - 1];
        return { text, cursor };
      });
      return line;
    }),
  );

  // ---- missing heading: opens at the top with a notice ----
  await page.click(".tree-row >> text=수식");
  await page.waitForSelector(".cm-content");
  await page.keyboard.press("Control+e");
  await page.waitForSelector(".note-view");
  await page.click(".note-view a.wikilink >> text=회의록 › 없는 제목");
  await page.waitForSelector(".toast", { timeout: 5000 });
  console.log("missing heading toast:", await page.$eval(".toast", (t) => t.textContent));

  // ---- tag click opens search ----
  await page.click(".tree-row >> text=수식");
  await page.waitForSelector(".note-view");
  await page.evaluate(() => window.__notevine.getState().setPanels({ leftOpen: false }));
  await page.click(".note-view a.tag");
  await page.waitForSelector(".sidebar input");
  await page.waitForTimeout(600);
  const search = await st(() => ({
    tab: window.__notevine.getState().sidebarTab,
    query: document.querySelector(".sidebar input")?.value,
    hits: [...document.querySelectorAll(".sidebar li")].map((l) => l.textContent.slice(0, 20)),
  }));
  console.log("tag search:", JSON.stringify(search));

  // ---- Ctrl+T inserts a template ----
  await page.click(".side-tabs button >> text=파일");
  await page.click(".tree-row >> text=업무");
  await page.waitForSelector(".note-title >> text=업무");
  if (await page.$(".note-view")) await page.keyboard.press("Control+e");
  await page.waitForSelector(".cm-content");
  await page.click(".cm-line >> nth=-1");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+t");
  await page.waitForSelector(".palette-list.templates li");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  console.log("after Ctrl+T:\n" + (await st(() => window.__notevine.getState().docText)));

  console.log("remote requests:", remote);
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
