// 플러그인(FR-EXT-02)과 캔버스를 실제 앱에서 확인한다. 개발 빌드를 --remote-debugging-port=9222로 띄운 뒤 실행.
// 사용: node tests/e2e/plugins-canvas.cjs [스크린샷 폴더]
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SHOTS = process.argv[2] || os.tmpdir();
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "plugcanvas-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "회의.md"), "# 회의\n\n주간 회의는 목요일 10시.\n");
fs.writeFileSync(path.join(VAULT, "비밀.md"), "# 비밀\n\n#비공개 내용\n");

// A plugin that asks for nothing and tries to get out of its box.
function plugin(id, permissions, main) {
  const d = path.join(VAULT, ".app", "plugins", id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ id, name: id, version: "1.0.0", permissions }));
  fs.writeFileSync(path.join(d, "main.js"), main);
}
plugin(
  "probe",
  [],
  `const out = ["tauri:" + typeof window.__TAURI_INTERNALS__, "ipc:" + typeof window.ipc];
try { parent.document.title; out.push("parent:open"); } catch { out.push("parent:blocked"); }
fetch("https://example.com/").then(() => "fetch:open", () => "fetch:blocked").then(async (r) => {
  out.push(r);
  out.push(await notevine.notes.list().then(() => "read:open", (e) => "read:denied"));
  out.push(await notevine.net.fetch("https://example.com/").then(() => "net:open", () => "net:denied"));
  await notevine.panel.show("검사");
  await notevine.panel.set(out.map((x) => "<p>" + x + "</p>").join("") + "<img src=x onerror=alert(1)><script>alert(2)</script>");
});`,
);
plugin("nav", [], `setTimeout(() => { location.href = "https://example.com/"; }, 50);`);
plugin("netreader", ["read", "network"], `notevine.notes.read("비밀.md").then(() => notevine.panel.set("<p>secret:open</p>"), (e) => notevine.panel.set("<p>secret:" + e.message + "</p>")).then(() => notevine.panel.show("비공개"));`);
plugin("grower", ["read", "write"], `notevine.panel.show("늘어남");`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => {
    errors.push("dialog:" + d.message());
    void d.dismiss();
  });
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 2);
  const api = (name, ...args) => page.evaluate(([n, a]) => window.__notevineApi[n](...a), [name, args]);
  const st = (fn, arg) => page.evaluate(fn, arg);

  // ---------- canvas ----------
  await st(() => window.__notevine.getState().createCanvas(""));
  await page.waitForSelector(".canvas-stage");
  await page.keyboard.press("Escape"); // keep the name the tree offered
  await sleep(200);
  const cpath = await st(() => window.__notevine.getState().canvasView);
  console.log("canvas opened:", cpath, "| tree has it:", await st((p) => !!document.querySelector(".tree-row.active"), cpath));

  const stage = await page.locator(".canvas-stage").boundingBox();
  await page.mouse.dblclick(stage.x + stage.width * 0.3, stage.y + stage.height * 0.4);
  await page.waitForSelector(".cv-textarea");
  await page.keyboard.type("첫 카드 **굵게** [[회의]]");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "＋ 노트" }).click();
  await page.keyboard.type("회의");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".cv-node.file .note-view p");
  console.log("note card:", await page.locator(".cv-node.file .cv-file-title").innerText(), "|", (await page.locator(".cv-node.file .note-view").innerText()).trim());
  console.log("text card html:", await page.locator(".cv-node.text .note-view").innerHTML());

  // Draw a line from the text card's right dot onto the note card.
  const text = page.locator(".cv-node.text");
  await text.hover();
  const dot = await text.locator(".cv-dot.right").boundingBox();
  const fileBox = await page.locator(".cv-node.file").boundingBox();
  await page.mouse.move(dot.x + 6, dot.y + 6);
  await page.mouse.down();
  await page.mouse.move(fileBox.x + 20, fileBox.y + fileBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(700);
  let saved = JSON.parse(await api("readNote", cpath));
  console.log("saved:", saved.nodes.map((n) => n.type).join(","), "edges:", saved.edges.length, JSON.stringify(saved.edges.map((e) => [e.fromSide, e.toSide])));

  // Move the note card, then undo the move and the line.
  const before = saved.nodes.find((n) => n.type === "file");
  await page.mouse.move(fileBox.x + 60, fileBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(fileBox.x + 160, fileBox.y + 112, { steps: 6 });
  await page.mouse.up();
  await sleep(600);
  saved = JSON.parse(await api("readNote", cpath));
  const after = saved.nodes.find((n) => n.type === "file");
  const zoom = await st(() => document.querySelector(".canvas-world").style.transform);
  console.log("moved by:", after.x - before.x, after.y - before.y, "|", zoom);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await sleep(600);
  saved = JSON.parse(await api("readNote", cpath));
  console.log("after 2× undo: edges", saved.edges.length, "file at", saved.nodes.find((n) => n.type === "file").x === before.x);
  await page.keyboard.press("Control+y");
  await sleep(600);
  saved = JSON.parse(await api("readNote", cpath));
  console.log("after redo: edges", saved.edges.length);
  await page.screenshot({ path: path.join(SHOTS, "canvas.png") });

  // Rename keeps .canvas and the board stays open.
  await st((p) => window.__notevine.getState().rename(p, "계획"), cpath);
  await sleep(500);
  console.log("renamed:", await st(() => window.__notevine.getState().canvasView), fs.existsSync(path.join(VAULT, "계획.canvas")));

  // ---------- plugins ----------
  await api("createSamplePlugin");
  for (const id of ["hello-notevine", "probe", "nav", "netreader", "grower"]) await api("setPluginGrant", id, true);
  // A new version asks for more: what was granted no longer covers it.
  plugin("grower", ["read", "write", "network"], `notevine.panel.show("늘어남");`);
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 2);
  await st(() => window.__notevine.getState().openNote("회의.md"));
  await page.waitForSelector('.plugin-panel[data-plugin="hello-notevine"] .plugin-body b');
  console.log("sample panel:", await page.locator('.plugin-panel[data-plugin="hello-notevine"]').innerText());
  await page.waitForSelector('.plugin-panel[data-plugin="probe"] p');
  console.log("probe panel:", (await page.locator('.plugin-panel[data-plugin="probe"] .plugin-body').innerHTML()));
  await page.waitForSelector('.plugin-panel[data-plugin="netreader"] p');
  console.log("netreader:", await page.locator('.plugin-panel[data-plugin="netreader"] .plugin-body').innerText());
  console.log("grower (permission grew, so off):", await page.locator('.plugin-panel[data-plugin="grower"]').count());
  await sleep(500);
  console.log("frames:", page.frames().map((f) => f.url()).join(" | "));

  // The sample's command, from the palette, writes into the open note.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+p");
  await page.keyboard.type("오늘 날짜");
  await sleep(200);
  console.log("palette:", await page.locator(".palette-list li").first().innerText());
  await page.keyboard.press("Enter");
  await sleep(1500);
  console.log("note now:", JSON.stringify(await api("readNote", "회의.md")));
  // The panel's button.
  await page.locator('.plugin-panel[data-plugin="hello-notevine"] button[data-action="refresh"]').click();
  await sleep(300);
  console.log("after refresh:", await page.locator('.plugin-panel[data-plugin="hello-notevine"] .plugin-body p').innerText());
  await page.screenshot({ path: path.join(SHOTS, "plugins.png") });

  await st(() => window.__notevine.getState().setModal("settings"));
  await page.getByRole("button", { name: "플러그인", exact: true }).click();
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, "plugin-settings.png") });
  await st(() => window.__notevine.getState().setModal(null));

  // Turning them off removes their panels and commands.
  for (const id of ["hello-notevine", "probe", "nav", "netreader", "grower"]) await api("setPluginGrant", id, false);
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 2);
  await sleep(500);
  console.log("after off: panels", await page.locator(".plugin-panel").count(), "frames", await page.locator(".plugin-frames iframe").count());
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
