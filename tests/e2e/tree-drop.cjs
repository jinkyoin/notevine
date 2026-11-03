// Windows 탐색기에서 파일 트리로 파일 끌어다 놓기: 폴더 위 → 그 폴더, 노트 위 → 그 노트의 폴더, 빈 곳 → 맨 위.
// 탐색기 끌기는 흉내 낸다(DataTransfer에 File을 넣어 drop 이벤트). 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "treedrop-" + Date.now());
fs.mkdirSync(path.join(VAULT, "자료"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "자료", "안내.md"), "# 안내\n");
fs.writeFileSync(path.join(VAULT, "자료", "견적서.xlsx"), "old");
fs.writeFileSync(path.join(VAULT, "메모.md"), "# 메모\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForSelector(".tree-row.folder");

  // Drops File objects (name → text) on the element, the way Explorer would.
  const drop = (selector, files) =>
    page.evaluate(
      ([sel, list]) => {
        const [css, text] = sel.split("|");
        const el = [...document.querySelectorAll(css)].find((x) => !text || x.textContent.includes(text));
        const dt = new DataTransfer();
        for (const [name, text] of list) dt.items.add(new File([text], name));
        const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
        el.dispatchEvent(new DragEvent("dragenter", opts));
        const over = new DragEvent("dragover", opts);
        el.dispatchEvent(over);
        const hover = el.classList.contains("drop-target");
        el.dispatchEvent(new DragEvent("drop", opts));
        return { accepted: over.defaultPrevented, hover };
      },
      [selector, files],
    );
  const wait = () => page.waitForTimeout(1200);
  const ls = (d) => fs.readdirSync(path.join(VAULT, d)).filter((n) => !n.startsWith(".")).sort();

  console.log("onto folder:", JSON.stringify(await drop('.tree-row.folder', [["견적서.xlsx", "new"], ["사진.png", "png"]])));
  await wait();
  console.log("  자료/:", ls("자료"), "| old kept:", fs.readFileSync(path.join(VAULT, "자료", "견적서.xlsx"), "utf8"));
  console.log("  toast:", JSON.stringify(await page.evaluate(() => window.__notevine.getState().toasts.map((t) => t.message))));

  await page.evaluate(() => window.__notevine.getState().toggleFolder("자료", true));
  await page.waitForSelector('.tree-row.note >> text=안내');
  console.log("onto a note in 자료:", JSON.stringify(await drop(".tree-row.note|안내", [["회의록.hwp", "hwp"]])));
  await wait();
  console.log("  자료/:", ls("자료"), "| root:", ls(""));

  console.log("onto empty area:", JSON.stringify(await drop(".tree", [["맨위.txt", "top"]])));
  await wait();
  console.log("  root:", ls(""));
  console.log("tree shows:", (await page.locator(".tree-row").allInnerTexts()).map((s) => s.trim()).join(" | "));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
