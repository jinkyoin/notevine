// AI 패널의 입력 칸 하나로 질문·웹 검색·작성·템플릿 작성이 되는지 확인한다.
// 실제 AI와 웹 검색을 쓴다(구독 사용량을 조금 씀). 개발 빌드를 포트 9222로 띄운 뒤 실행.
// 사용: node tests/e2e/ai-web-request.cjs [claude|codex]
const { chromium } = require("playwright-core");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROVIDER = process.argv[2] || "claude";
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "aiweb-" + Date.now());
const TEMPLATES = path.join(VAULT, "90.템플릿");
fs.mkdirSync(TEMPLATES, { recursive: true });
// Words of the question appear here, so a plain search would offer these notes.
fs.writeFileSync(path.join(VAULT, "도서 목록.md"), "# 도서 목록\n\n올해 읽을 도서를 검색하여 요약해 둔다. 내부코드 ZX-4471\n");
fs.writeFileSync(path.join(VAULT, "지난주 회의.md"), "# 지난주 회의\n\n결정: 3월 개통\n");
fs.writeFileSync(path.join(VAULT, "일기.md"), "# 일기\n\n오늘 결정을 미뤘다.\n");
fs.writeFileSync(path.join(VAULT, "비밀.md"), "# 비밀\n\n#비공개 도서 구입비 3천만원\n");
fs.writeFileSync(path.join(VAULT, "독후감.md"), "# 독후감\n\n첫 줄은 그대로 둔다.\n");
fs.writeFileSync(path.join(TEMPLATES, "독서템플릿.md"), "# 독서 기록\n\n## 책 정보\n\n## 한 줄 평\n\n## 인상 깊은 내용\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.evaluate((p) => {
    localStorage.setItem("notevine.ai.enabled", "1");
    localStorage.setItem("notevine.ai.provider", p);
    localStorage.setItem("notevine.ai.web", "0"); // off: asking for the web must still work
  }, PROVIDER);
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 5);
  await page.waitForSelector(".ai-head select", { timeout: 30000 });
  await sleep(1500); // the index
  const ai = (fn) => page.evaluate(fn);
  const send = async (text) => {
    await page.fill(".ai-input textarea", text);
    await page.keyboard.press("Enter");
  };
  const sendDialog = async () => {
    await page.waitForSelector(".modal.ai-send");
    await sleep(800);
    assert.strictEqual(await page.locator(".modal.ai-send").count(), 1, "the Enter that sent the request also answered the dialog");
    return page.evaluate(() => {
      const r = window.__notevineAi.getState().send;
      return { notes: r.notes.map((n) => n.title), checked: r.checked, target: r.target };
    });
  };
  const finished = async () => {
    const t0 = Date.now();
    await page.waitForFunction(() => window.__notevineAi.getState().running, null, { timeout: 30000 });
    await page.waitForFunction(() => !window.__notevineAi.getState().running, null, { timeout: 300000 });
    const m = await ai(() => {
      const s = window.__notevineAi.getState();
      const a = s.chat.at(-1);
      return { text: a.text, error: a.error, sources: a.sources, steps: a.progress ?? [], proposal: !!a.proposal, written: a.written, items: (s.edits?.items ?? []).map((i) => ({ kind: i.edit.kind, path: i.path, error: i.error, after: i.after })) };
    });
    console.log(`   finished in ${((Date.now() - t0) / 1000).toFixed(0)}s, web steps ${m.steps.length}, proposals ${m.items.length}`);
    assert.ok(!m.error, "error: " + m.error);
    return m;
  };

  // 0) One box, no tabs.
  assert.strictEqual(await page.locator(".ai-mode").count(), 0, "the tabs are still there");

  // 1) A question about my notes asks first, and only good hits are checked.
  await send("지난주 회의 결정 찾아줘");
  let d = await sendDialog();
  assert.ok(d.checked.includes("지난주 회의.md"), "the meeting isn't checked: " + JSON.stringify(d));
  assert.ok(d.notes.includes("일기") && !d.checked.includes("일기.md"), "a one-word body hit should be listed unchecked: " + JSON.stringify(d));
  assert.ok(!d.notes.includes("비밀"), "private note offered");
  assert.strictEqual(d.target, undefined, "a question has no note to write to");
  console.log("1 note question: ok");
  await page.click(".modal.ai-send .btn.ghost");

  // 2) Plainly asking for the web: no dialog, no notes, an answer to save or copy.
  await send("'창발의 시대'란 도서를 검색하여 요약해줘");
  let m = await finished();
  assert.strictEqual(await page.locator(".modal.ai-send").count(), 0, "dialog shown");
  assert.deepStrictEqual(m.sources, [], "notes sent");
  assert.ok(m.steps.some((s) => /웹 검색/.test(s)), "did not search the web");
  assert.ok(/\]\(https?:\/\//.test(m.text), "no web source links");
  assert.ok(!/ZX-4471|3천만/.test(m.text), "note content leaked");
  assert.strictEqual(m.items.length, 0, "a question became a proposal");
  assert.ok(await page.getByRole("button", { name: "새 노트로 저장" }).last().isVisible(), "no save button");
  console.log("2 web question: ok");
  await page.evaluate(() => window.__notevineAi.getState().newChat());

  // 3) Asked to write with a note open: a proposal for that note, applied only when confirmed.
  await page.evaluate(() => window.__notevine.getState().openNote("독후감.md"));
  await page.waitForSelector(".cm-content");
  await send("창발의 시대 책을 노트나 웹에서 검색해서 세 문장으로 작성해줘");
  d = await sendDialog();
  assert.strictEqual(d.target, "독후감", "no target: " + JSON.stringify(d));
  assert.ok(d.checked.includes("독후감.md"), "the open note should be checked");
  await sleep(500);
  await page.click(".modal.ai-send .btn.primary");
  m = await finished();
  console.log("   items", JSON.stringify(m.items.map((i) => [i.kind, i.path, i.error])));
  assert.ok(m.items.some((i) => i.kind === "append" && i.path === "독후감.md" && !i.error), "no proposal for the open note: " + m.text.slice(0, 300));
  const note = path.join(VAULT, "독후감.md");
  assert.ok(!fs.readFileSync(note, "utf8").includes("창발"), "applied before confirming");
  await page.click(".ae-foot .btn.ghost, .ae-foot .btn:not(.primary)");
  assert.strictEqual(fs.readFileSync(note, "utf8").includes("창발"), false, "cancel applied it");
  await page.getByRole("button", { name: "바뀌는 부분 보기" }).first().click(); // reopen
  await page.waitForSelector(".ai-edits");
  await page.click(".ae-foot .btn.primary");
  await page.waitForFunction(() => !window.__notevineAi.getState().edits);
  await sleep(1500);
  const applied = await page.evaluate(() => window.__notevineApi.readNote("독후감.md"));
  assert.ok(applied.startsWith("# 독후감\n\n첫 줄은 그대로 둔다."), "the note's start changed: " + applied.slice(0, 80));
  assert.ok(applied.length > 30, "nothing appended");
  console.log("3 write to the open note: ok");
  await page.evaluate(() => window.__notevineAi.getState().newChat());

  // 4) A missing template stops with the ones there are.
  await send("요리 템플릿에 맞게 작성해줘");
  await page.waitForFunction(() => window.__notevine.getState().toasts.some((t) => t.message.includes("독서템플릿")), null, { timeout: 10000 });
  assert.strictEqual(await ai(() => window.__notevineAi.getState().chat.length), 0, "went ahead without the template");
  console.log("4 missing template: ok");

  // 5) A template, no note open: the text in that format, to save or copy; nothing proposed.
  await page.evaluate(() => window.__notevine.getState().closeTab());
  await sleep(500);
  assert.strictEqual(await ai(() => window.__notevine.getState().openPath), null, "a note is still open");
  {
    await send("창발의 시대 책을 노트나 웹에서 찾아서 템플릿 폴더에 있는 독서템플릿에 맞게 작성해줘");
    d = await sendDialog();
    assert.ok(d.notes.includes("독서템플릿") && d.checked.includes("90.템플릿/독서템플릿.md"), "template not offered: " + JSON.stringify(d));
    assert.strictEqual(d.target, undefined);
    await sleep(500);
    await page.click(".modal.ai-send .btn.primary");
    m = await finished();
    console.log("----- answer -----\n" + m.text.slice(0, 500) + "\n------------------");
    assert.ok(m.written, "not marked as writing");
    assert.strictEqual(m.items.length, 0, "proposed changes with no note open: " + JSON.stringify(m.items.map((i) => i.path)));
    assert.ok(/책 정보/.test(m.text) && /한 줄 평/.test(m.text) && /인상 깊은 내용/.test(m.text), "template format not followed");
    assert.ok(await page.getByRole("button", { name: "새 노트로 저장" }).last().isVisible(), "no save button");
    assert.ok(await page.getByRole("button", { name: "복사" }).last().isVisible(), "no copy button");
    assert.ok(fs.readFileSync(path.join(TEMPLATES, "독서템플릿.md"), "utf8").startsWith("# 독서 기록"), "the template changed");
    console.log("5 template, no open note: ok");
  }

  await page.evaluate(() => localStorage.removeItem("notevine.ai.web"));
  assert.deepStrictEqual(errors, [], "page errors");
  console.log("ALL PASSED");
  await browser.close();
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
