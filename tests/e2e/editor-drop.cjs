// 편집기에 파일 끌어다 놓기: 글 위(놓은 자리), 글 아래 빈 곳(노트 끝), 읽기 모드(안 받음).
// 탐색기 끌기는 흉내 낸다(DataTransfer에 File을 넣어 drop). 개발 빌드를 포트 9222로 띄운 뒤 실행.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const VAULT = path.join(os.tmpdir(), "notevine-e2e", "edrop-" + Date.now());
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "노트.md"), "# 노트\n\n첫 줄\n둘째 줄\n");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await page.waitForSelector(".main, .start-card");
  await page.evaluate((v) => window.__notevine.getState().openVault(v), VAULT);
  await page.waitForFunction(() => window.__notevine.getState().notes.length >= 1);
  await page.evaluate(() => {
    window.__notevine.getState().setReadMode(false);
    window.__notevine.getState().openNote("노트.md");
  });
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(800);

  // where: "line" (on the text "첫 줄"), "below" (empty space under the text)
  const drop = (where, files) =>
    page.evaluate(
      ([w, list]) => {
        let target;
        let x;
        let y;
        if (w === "line") {
          target = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "첫 줄");
          const b = target.getBoundingClientRect();
          x = b.left + 200; // past the end of the line
          y = b.top + b.height / 2;
        } else {
          target = document.querySelector(".editor");
          const b = target.getBoundingClientRect();
          x = b.left + b.width / 2;
          y = b.bottom - 40;
          target = document.elementFromPoint(x, y);
        }
        const dt = new DataTransfer();
        for (const [name, type] of list) dt.items.add(new File(["x"], name, { type }));
        const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y };
        const over = new DragEvent("dragover", opts);
        target.dispatchEvent(over);
        const drop = new DragEvent("drop", opts);
        target.dispatchEvent(drop);
        return { on: target.className, accepted: over.defaultPrevented && drop.defaultPrevented };
      },
      [where, files],
    );
  const text = () => page.evaluate(() => window.__notevine.getState().docText ?? "");

  console.log("on a line:", JSON.stringify(await drop("line", [["견적서.xlsx", ""]])));
  await page.waitForTimeout(1500);
  console.log("below the text:", JSON.stringify(await drop("below", [["사진.png", "image/png"], ["회의록.hwp", ""]])));
  await page.waitForTimeout(1800);
  console.log("note:", JSON.stringify(await text()));
  console.log("첨부:", fs.readdirSync(path.join(VAULT, "첨부")));

  await page.evaluate(() => window.__notevine.getState().setReadMode(true));
  await page.waitForTimeout(500);
  console.log("read mode:", JSON.stringify(await drop("below", [["안됨.txt", ""]])));
  await page.waitForTimeout(800);
  console.log("첨부 after read-mode drop:", fs.readdirSync(path.join(VAULT, "첨부")));
  await page.evaluate(() => window.__notevine.getState().setReadMode(false));
  console.log("errors:", errors);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
