// API 키·Ollama 연결(FR-AI-07). 실제 AI는 쓰지 않는다:
// - Ollama 자리에 가짜 서버(이 스크립트가 127.0.0.1:11555에 띄움)를 두고 질문→스트리밍 답까지 확인
// - Claude API 키는 일부러 틀린 키를 넣어 저장·오류 안내·지우기를 확인 (노트 내용은 보내지 않음)
const http = require("http");
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 11555;
const seen = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/api/tags") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ models: [{ name: "가짜모델:1b" }, { name: "other:7b" }] }));
    }
    if (req.url === "/api/chat") {
      const j = JSON.parse(body);
      seen.push(`model=${j.model} system=${j.messages[0].role} user-has-note=${j.messages[1].content.includes("<참고 노트>")}`);
      res.setHeader("Content-Type", "application/x-ndjson");
      for (const part of ["회의는 ", "목요일", "입니다 [[회의]]"]) res.write(JSON.stringify({ message: { content: part }, done: false }) + "\n");
      return res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
    }
    res.statusCode = 404;
    res.end();
  });
});

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "aiapi-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "회의.md"), "# 회의\n\n주간 회의는 목요일 10시.\n");

(async () => {
  await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 1);
  const api = (name, ...args) => page.evaluate(([n, a]) => window.__notevineApi[n](...a), [name, args]);
  const before = await page.evaluate(() => window.__notevineApi.appSettings());

  try {
    // 1) Ollama at our fake address: listed, models, a streamed answer with the note.
    await api("setOllamaUrl", `http://127.0.0.1:${PORT}`);
    const list = await api("aiProviders", true);
    console.log("1 providers:", JSON.stringify(list.filter((p) => ["anthropic", "openai", "ollama"].includes(p.id)).map((p) => [p.id, p.available])));
    console.log("1 models:", JSON.stringify(await api("aiModels", "ollama")));
    const events = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const got = [];
          window.__notevineApi.aiRun("t-ollama", "ollama", "도우미", "회의 언제야?", ["회의.md"], null, false, (e) => {
            got.push(e);
            if (e.kind === "done" || e.kind === "error") resolve(got);
          });
        }),
    );
    console.log("1 events:", JSON.stringify(events.map((e) => (e.kind === "delta" ? e.text : e.kind === "started" ? `started:${e.model}` : e.kind))));
    console.log("1 done text:", JSON.stringify(events.at(-1).text));
    console.log("1 server saw:", JSON.stringify(seen.filter((s) => !s.startsWith("GET"))));

    // 2) A non-local Ollama address is not used.
    await api("setOllamaUrl", "http://example.com:11434");
    const far = (await api("aiProviders", true)).find((p) => p.id === "ollama");
    console.log("2 remote address falls back:", JSON.stringify(far.detail));

    // 3) A wrong Claude key: saved (only "available" is visible), a clear error, then removed.
    await api("aiSetKey", "anthropic", "sk-ant-wrong-key-for-test");
    const a = (await api("aiProviders", true)).find((p) => p.id === "anthropic");
    console.log("3 key saved → available:", a.available, "| key visible to page:", JSON.stringify(a).includes("wrong-key"));
    const err = await page.evaluate(() => window.__notevineApi.aiModels("anthropic").catch((e) => e.message));
    console.log("3 wrong key:", JSON.stringify(err));
  } finally {
    await api("aiSetKey", "anthropic", "");
    await api("setOllamaUrl", before.ollama_url ?? "");
  }
  const gone = (await api("aiProviders", true)).find((p) => p.id === "anthropic");
  console.log("3 removed → available:", gone.available);
  console.log("errors:", errors);
  await browser.close();
  fake.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  fake.close();
  process.exit(1);
});
