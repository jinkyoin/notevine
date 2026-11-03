// 영어 화면(FR-UI-03), Git 백업, 개발용 빌드 설정 분리를 실제 앱에서 확인한다.
// 개발 빌드를 --remote-debugging-port=9222로 띄운 뒤 실행. 사용: node tests/e2e/english-backup.cjs [스크린샷 폴더]
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SHOTS = process.argv[2] || os.tmpdir();
const VAULT = path.join(os.tmpdir(), "notevine-e2e", "english-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "Meeting.md"), "# Weekly meeting\n\n- Launch in March\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.evaluate(() => localStorage.setItem("notevine.lang", "en"));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  if (await page.locator(".start-card").count()) {
    await page.screenshot({ path: path.join(SHOTS, "en-start.png") });
    const start = await page.locator(".start-card").innerText({ timeout: 2000 }).catch(() => "(reopened the last folder)");
    console.log("start screen:", start.replace(/\s+/g, " ").slice(0, 160));
  }
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 1);
  await page.evaluate(() => window.__notevine.getState().openNote("Meeting.md"));
  await page.waitForSelector(".cm-content");
  await sleep(500);
  await page.screenshot({ path: path.join(SHOTS, "en-main.png") });
  const korean = await page.evaluate(() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const n = walk.currentNode;
      if (/[가-힣]/.test(n.textContent) && !n.parentElement.closest(".cm-editor, .note-view, .tree")) out.push(n.textContent.trim());
    }
    for (const el of document.querySelectorAll("[title], [placeholder], [aria-label]")) {
      for (const a of ["title", "placeholder", "aria-label"]) {
        const v = el.getAttribute(a);
        if (v && /[가-힣]/.test(v)) out.push(`${a}=${v}`);
      }
    }
    return out;
  });
  console.log("Korean left on the main screen:", JSON.stringify(korean));

  // Command palette.
  await page.keyboard.press("Control+p");
  await page.waitForSelector(".palette-list li");
  console.log("palette:", (await page.locator(".palette-list li").allInnerTexts()).slice(0, 6).map((s) => s.replace(/\s+/g, " ")).join(" | "));
  await page.screenshot({ path: path.join(SHOTS, "en-palette.png") });
  await page.keyboard.press("Escape");

  // Settings → Backup: make a repository and back up.
  await page.evaluate(() => window.__notevine.getState().setModal("settings"));
  await page.getByRole("button", { name: "Backup", exact: true }).click();
  await page.getByRole("button", { name: "Create Git repository" }).click();
  await page.waitForSelector("text=Back up now");
  await page.getByRole("button", { name: "Back up now" }).click();
  await page.waitForFunction(() => window.__notevine.getState().toasts.some((t) => /Backed up|Could not back up/.test(t.message)), null, { timeout: 30000 });
  console.log("toast:", JSON.stringify(await page.evaluate(() => window.__notevine.getState().toasts.map((t) => t.message))));
  await sleep(800);
  await page.screenshot({ path: path.join(SHOTS, "en-backup.png") });
  const st = await page.evaluate(() => window.__notevineApi.backupStatus());
  console.log("backup status:", JSON.stringify(st));
  console.log(".gitignore:", JSON.stringify(fs_read(path.join(VAULT, ".gitignore"))));

  // An error from the backend in English.
  const err = await page.evaluate(() => window.__notevineApi.createNote("", "Meeting").catch((e) => e));
  console.log("backend error:", JSON.stringify(await page.evaluate((e) => {
    return import("/src/api.ts").then((m) => m.errorMessage(e)).catch(() => "(dev import unavailable)");
  }, err)));

  await page.getByRole("button", { name: "General", exact: true }).click();
  await sleep(200);
  await page.screenshot({ path: path.join(SHOTS, "en-settings.png") });
  await page.evaluate(() => window.__notevine.getState().setModal(null));

  // Back to Korean for later tests.
  await page.evaluate(() => localStorage.setItem("notevine.lang", "ko"));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});

function fs_read(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
