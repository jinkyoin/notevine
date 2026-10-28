// NFR-PRF-01~05 측정: 릴리스 빌드(notevine.exe)를 직접 띄워 1만 노트 볼트로 잰다.
const { chromium } = require("playwright-core");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const EXE = path.join(__dirname, "..", "..", "src-tauri", "target", "release", "notevine.exe");
const VAULT = process.env.NOTEVINE_PERF_VAULT || path.join(require("os").tmpdir(), "notevine-e2e", "vault10k");
fs.mkdirSync(path.dirname(VAULT), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

function launch() {
  const t0 = Date.now();
  const proc = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9333" },
    stdio: "ignore",
  });
  return { proc, t0 };
}

async function connect() {
  for (let i = 0; i < 200; i++) {
    try {
      const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
      const page = b.contexts()[0]?.pages()[0];
      if (page) return { b, page };
      await b.close();
    } catch {}
    await sleep(50);
  }
  throw new Error("could not connect to the app");
}

const invoke = (page, cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

function kill(proc) {
  try {
    execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

(async () => {
  // A) first indexing of 10k notes (NFR-PRF-03 ≤ 60 s): no .app, open, wait until all notes are indexed
  fs.rmSync(path.join(VAULT, ".app"), { recursive: true, force: true });
  let { proc } = launch();
  let { b, page } = await connect();
  await page.waitForSelector(".start-card, .tree-row, .empty", { timeout: 20000 });
  const t0 = Date.now();
  await invoke(page, "open_vault", { path: VAULT });
  let n = 0;
  while (Date.now() - t0 < 120000) {
    n = (await invoke(page, "list_notes", {})).length;
    if (n >= 10002) break;
    await sleep(200);
  }
  results.initialIndex = { notes: n, seconds: +((Date.now() - t0) / 1000).toFixed(1), limit: 60 };
  await b.close();
  kill(proc);
  await sleep(1500);

  // B) start-up with an existing index (NFR-PRF-01 ≤ 3 s): app reopens the last vault on its own
  ({ proc, t0: startT } = launch());
  var startT;
  ({ b, page } = await connect());
  await page.waitForSelector(".tree-row", { timeout: 30000 });
  results.startup = { seconds: +((Date.now() - startT) / 1000).toFixed(2), limit: 3 };

  // C) full-text search, 20 queries (NFR-PRF-02 ≤ 200 ms average)
  const queries = ["무개", "업무", "개선", "회의 보고", "자동화", "프로젝트", "결정 사항", "후속 조치", "고객 요청", "링크",
    "히스토리 템플릿", "배포", "설계", "주간", "성과", "위험", "담당자", "출처", "문서 요구사항", "검색"];
  const took = [];
  const round = [];
  for (const q of queries) {
    const s = Date.now();
    const r = await invoke(page, "search", { query: { text: q.split(" "), tags: [], props: [], limit: 100 } });
    round.push(Date.now() - s);
    took.push(r.took_ms);
  }
  const avg = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  results.search = { avgBackendMs: avg(took), maxBackendMs: Math.max(...took), avgRoundTripMs: avg(round), limit: 200 };
  // with filters too
  const s2 = Date.now();
  const f = await invoke(page, "search", { query: { text: ["업무"], tags: ["자동화"], props: [{ key: "status", op: "eq", value: "검토" }], limit: 100 } });
  results.searchFiltered = { ms: Date.now() - s2, backendMs: f.took_ms, total: f.total };

  // D) typing latency in a 1 MB note (NFR-PRF-04 ≤ 50 ms), with a small note as the
  // baseline: the difference is what the note's size costs; the rest is measurement overhead.
  const cdp = await page.context().newCDPSession(page);
  async function typing(open) {
    await open();
    await page.waitForSelector(".cm-content");
    await sleep(1500);
    await page.click(".cm-content");
    await page.keyboard.press("Control+End");
    const lat = [];
    for (let i = 0; i < 60; i++) {
      const s = await page.evaluate(() => performance.now());
      await cdp.send("Input.insertText", { text: "가" });
      const e = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(performance.now()))));
      lat.push(e - s);
    }
    // undo the typing so the test vault stays clean
    for (let i = 0; i < 60; i++) await page.keyboard.press("Backspace");
    await page.keyboard.press("Control+s");
    await sleep(1200);
    lat.sort((x, y) => x - y);
    return { medianMs: +lat[30].toFixed(1), p95Ms: +lat[57].toFixed(1) };
  }
  const small = await typing(async () => {
    await page.click(".tree-row.folder >> nth=0");
    await page.click(".tree-row.note >> nth=0");
  });
  const big = await typing(() => page.click(".tree-row.note >> text=big-note"));
  const para = await typing(() => page.click(".tree-row.note >> text=big-paragraph"));
  results.typing = { smallNote: small, note1MB: big, oneParagraph1MB: para, limit: 50 };

  // E) idle memory of the app process tree (NFR-PRF-05 ≤ 200 MB), with an ordinary note open.
  // Private bytes are what the app actually uses; working set also counts shared WebView2 DLLs per process.
  await page.click(".tree-row.note >> nth=1").catch(() => {});
  await sleep(10000);
  const ps = `$root=${proc.pid}; $all=Get-CimInstance Win32_Process; $ids=@($root); do { $n=$ids.Count; $ids=@($ids + ($all | ? { $ids -contains $_.ParentProcessId } | % ProcessId) | Select -Unique) } while ($ids.Count -ne $n); $p = Get-Process -Id $ids -ErrorAction SilentlyContinue; $app=($p | ? ProcessName -eq 'notevine' | Measure PrivateMemorySize64 -Sum).Sum; $wv=($p | ? ProcessName -ne 'notevine' | Measure PrivateMemorySize64 -Sum).Sum; $ws=($p | Measure WorkingSet64 -Sum).Sum; '{0} {1} {2} {3}' -f [math]::Round($app/1MB), [math]::Round($wv/1MB), $p.Count, [math]::Round($ws/1MB)`;
  const [appMb, webviewMb, procs, wsMb] = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split(" ").map(Number);
  results.idleMemory = { privateAppMB: appMb, privateWebView2MB: webviewMb, privateTotalMB: appMb + webviewMb, workingSetTotalMB: wsMb, processes: procs, limit: 200 };

  await b.close();
  kill(proc);

  // F) installer size (NFR-PRF-05 ≤ 30 MB)
  const bundle = path.join(__dirname, "..", "..", "src-tauri", "target", "release", "bundle");
  const sizes = {};
  for (const d of ["msi", "nsis"]) {
    for (const f of fs.readdirSync(path.join(bundle, d)).filter((x) => /\.(msi|exe)$/.test(x))) {
      sizes[f] = +(fs.statSync(path.join(bundle, d, f)).size / 1024 / 1024).toFixed(1);
    }
  }
  results.installerMB = sizes;
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.message);
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
});
