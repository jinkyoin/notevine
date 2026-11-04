// 다른 사람에게서 받은 노트 폴더가 이 PC에서 아무것도 스스로 실행하지 못하는지 실제 앱에서 확인한다.
// 개발 빌드를 --remote-debugging-port=9222로 띄운 뒤 실행. 사용: node tests/e2e/vault-trust.cjs
const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "received-" + Date.now());
const app = path.join(VAULT, ".app");
const plugin = path.join(app, "plugins", "evil");
fs.mkdirSync(plugin, { recursive: true });

const git = (...args) => execFileSync("git", args, { cwd: VAULT, stdio: "pipe" });
fs.writeFileSync(path.join(VAULT, "회의.md"), "# 회의\n\n[[회의록.bat|회의록 보기]]\n\n" +
  '<img data-embed="사진.png" usemap="#m" width="300"><map name="m"><area shape="default" href="https://example.com/"></map>\n\n' +
  '<svg width="1" height="1"><image href="https://example.com/b.png"></image></svg>\n\n공개 문장\n');
fs.writeFileSync(path.join(VAULT, "비밀.md"), "# 비밀\n\n#비공개 비밀 문장\n");
fs.writeFileSync(path.join(VAULT, "회의록.bat"), "echo ran > bat-ran\r\n");
fs.writeFileSync(path.join(VAULT, "사진.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==", "base64"));
git("init", "-q", "-b", "main");
git("config", "user.name", "x");
git("config", "user.email", "x@x");
git("add", "-A");
git("commit", "-q", "-m", "받은 폴더");
git("config", "core.fsmonitor", "echo ran > fsmonitor-ran #");
fs.writeFileSync(path.join(app, "config.json"), JSON.stringify({ backup_minutes: 1, custom_css: true, plugins: { evil: ["read", "network"] }, link_click: "click" }));
fs.writeFileSync(path.join(app, "custom.css"), ".note-title { color: rgb(255, 0, 0) !important; }");
fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({ id: "evil", name: "evil", version: "1", permissions: ["read", "network"] }));
const MAIN = `notevine.panel.show("evil");
notevine.commands.add({ id: "sel", name: "선택 읽기", run: async () => {
  const r = await notevine.editor.selection().then((t) => "got:" + t, () => "blocked");
  const list = await notevine.notes.list();
  const git = await notevine.notes.read(".git/config").then(() => "git:open", () => "git:denied");
  await notevine.panel.set("<p>" + r + "|" + list.map((n) => n.path).join(",") + "|" + git + "</p>");
} });`;
fs.writeFileSync(path.join(plugin, "main.js"), MAIN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marker = (name) => fs.existsSync(path.join(VAULT, name));

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  const api = (name, ...args) => page.evaluate(([n, a]) => window.__notevineApi[n](...a), [name, args]);
  const state = (key) => page.evaluate((k) => window.__notevine.getState()[k], key);
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 2);
  await sleep(1500);

  // 1) Opening it starts nothing: its config grants nothing.
  assert.deepStrictEqual(await state("trust"), { git: false, backup_minutes: 0, custom_css: false }, "trust");
  assert.strictEqual(await page.locator(".plugin-frames iframe").count(), 0, "plugin ran");
  assert.strictEqual(await page.locator("#user-css").count(), 0, "css applied");
  const st = await api("backupStatus");
  assert.ok(st.repo && !st.trusted, "repository not trusted");
  assert.ok(!marker("fsmonitor-ran"), "fsmonitor ran on status");
  await assert.rejects(api("backupNow", "x"), undefined, "backup refused");
  await assert.rejects(api("pluginSource", "evil"), undefined, "plugin source refused");
  console.log("1 opening starts nothing: ok");

  // 2) A disguised link asks first, naming the real file; declining runs nothing.
  await page.evaluate(() => {
    const s = window.__notevine.getState();
    s.openNote("회의.md");
    s.setReadMode(true);
  });
  const link = page.locator("a.wikilink", { hasText: "회의록 보기" });
  await link.waitFor();
  await link.click();
  await page.getByText("이 파일을 열까요?").waitFor();
  assert.ok((await page.locator("body").innerText()).includes("회의록.bat"), "dialog names the file");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await sleep(800);
  assert.ok(!marker("bat-ran"), "bat ran");
  console.log("2 disguised link asks: ok");

  // 3) Nothing in a note loads or moves the window.
  assert.strictEqual(await page.locator("img[usemap], map, area, svg image").count(), 0, "markup survived");
  const before = page.url();
  await page.evaluate(() => {
    location.href = "https://example.com/";
  });
  await sleep(1500);
  assert.strictEqual(page.url(), before, "window moved");
  const loaded = await page.evaluate(
    () =>
      new Promise((res) => {
        const i = new Image();
        i.onload = () => res(true);
        i.onerror = () => res(false);
        i.src = "https://example.com/favicon.ico";
      }),
  );
  assert.strictEqual(loaded, false, "CSP let an image load");
  const fetched = await page.evaluate(() => fetch("https://example.com/").then(() => true, () => false));
  assert.strictEqual(fetched, false, "CSP let a fetch through");
  console.log("3 no loading, no leaving: ok");

  // 4) The user allows Git: it runs, and the repository's settings still can't run commands.
  const allowed = await api("backupTrust");
  assert.ok(allowed.trusted && allowed.branch === "main", "allowed");
  await api("backupStatus");
  assert.ok(!marker("fsmonitor-ran"), "fsmonitor ran after allowing");
  console.log("4 allowed Git stays harmless: ok");

  // 5) The user turns the plugin on. It sees no #비공개 note, nor files that aren't notes.
  await api("setPluginGrant", "evil", true);
  await page.evaluate(() => window.__notevine.getState().setReadMode(false));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector('.plugin-panel[data-plugin="evil"]');
  const runSelection = async (note) => {
    await page.evaluate((p) => window.__notevine.getState().openNote(p), note);
    await sleep(500);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+p");
    await page.keyboard.type("선택 읽기");
    await sleep(300);
    await page.keyboard.press("Enter");
    await sleep(800);
    return page.locator('.plugin-panel[data-plugin="evil"] .plugin-body').innerText();
  };
  const onPrivate = await runSelection("비밀.md");
  assert.ok(onPrivate.startsWith("blocked|"), "selection in a private note: " + onPrivate);
  assert.ok(!onPrivate.includes("비밀.md"), "private note listed: " + onPrivate);
  assert.ok(onPrivate.endsWith("git:denied"), ".git/config read: " + onPrivate);
  const onPublic = await runSelection("회의.md");
  assert.ok(onPublic.startsWith("got:"), "selection in a public note: " + onPublic);
  console.log("5 plugin sees no private note: ok");

  // 6) New code isn't what the user allowed.
  fs.writeFileSync(path.join(plugin, "main.js"), MAIN + "\n// 바뀜");
  await page.evaluate(() => window.__notevineApi.listPlugins());
  const [changed] = await api("listPlugins");
  assert.ok(changed.changed && changed.granted === null, "changed plugin off");
  await assert.rejects(api("pluginSource", "evil"), undefined, "changed plugin source refused");
  console.log("6 changed code needs a new grant: ok");

  // 7) The user's own CSS, once allowed, applies.
  await api("setCustomCss", true);
  await page.evaluate(() => window.__notevine.getState().setTrust({ git: true, backup_minutes: 0, custom_css: true }));
  await page.waitForSelector("#user-css", { state: "attached" });
  console.log("7 allowed CSS applies: ok");

  await api("setCustomCss", false);
  await page.evaluate(() => window.__notevine.getState().closeVault());
  assert.deepStrictEqual(errors, [], "page errors");
  console.log("ALL PASSED");
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
