// 배포본에 들어가는 오픈소스의 라이선스 고지를 모아 public/THIRD-PARTY-NOTICES.txt를 만든다.
// 패키지에 들어 있는 라이선스 원문을 그대로 쓰고, 같은 원문은 한 번만 적는다.
// 앱 안에서는 설정 > 정보 > 오픈소스 라이선스로 본다. 릴리스 빌드 전에 --check로 자동 실행되어,
// 원문을 못 찾은 패키지가 있으면 빌드가 실패한다. 패키지에 원문이 없으면 scripts/license-texts에 넣는다.
// 사용: node scripts/gen-notices.mjs [--check]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public", "THIRD-PARTY-NOTICES.txt");
const TARGET = "x86_64-pc-windows-msvc";
const TEXTS = path.join(ROOT, "scripts", "license-texts");
const LICENSE_FILE = /^(un)?licen[cs]e|^(mit|apache)-licen[cs]e|^copying|^notice|^copyright/i;
const NOT_TEXT = /\.(png|jpe?g|gif|svg|html?|json|rs|js|ts)$/i;

/** Where a package offers a choice, the one Notevine takes. */
const CHOSEN = { dompurify: "Apache-2.0", "r-efi": "MIT" };
/** A package that keeps its license file in a subfolder. */
const LICENSE_DIR = { pretendard: "dist" };
/**
 * Packages published without a license file: the text is kept in scripts/license-texts.
 * fastdom, strictdom: the License section of their README. selectors: the MPL-2.0 text from
 * cssparser, since its repository has no copy. The rest: the LICENSE of their repository.
 */
const KEPT_TEXT = {
  "@napi-rs/canvas-win32-x64-msvc": "napi-canvas.txt",
  "alloc-stdlib": "alloc-stdlib.txt",
  fastdom: "fastdom.txt",
  selectors: "selectors.txt",
  strictdom: "strictdom.txt",
  "webview2-com": "webview2-com.txt",
  "webview2-com-macros": "webview2-com.txt",
  "webview2-com-sys": "webview2-com.txt",
};

/** Files of the licenses in a package's own folder, or (in a folder of several) those named. */
function licenseTexts(dir) {
  if (!fs.existsSync(dir)) return [];
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name) && !NOT_TEXT.test(e.name))
    .map((e) => e.name)
    .sort();
  return names.map((n) => fs.readFileSync(path.join(dir, n), "utf8").replace(/\r\n/g, "\n").trim()).filter(Boolean);
}

function npmPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const out = [];
  for (const [p, e] of Object.entries(lock.packages)) {
    if (!p || e.dev || e.devOptional) continue;
    const dir = path.join(ROOT, p);
    if (!fs.existsSync(dir)) continue; // an optional package for another system
    const name = p.split("node_modules/").pop();
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const repo = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
    out.push({ name, version: e.version, license: e.license ?? meta.license ?? "(표기 없음)", url: meta.homepage ?? repo ?? "", dir });
  }
  return out;
}

/** The crates the app links on Windows: normal dependencies only, not build tools or tests. */
function cargoPackages() {
  const raw = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", TARGET], {
    cwd: path.join(ROOT, "src-tauri"),
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const meta = JSON.parse(raw);
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of nodes.get(id).deps) {
      if (d.dep_kinds.some((k) => k.kind === null)) walk(d.pkg);
    }
  };
  walk(meta.resolve.root);
  return meta.packages
    .filter((p) => seen.has(p.id) && p.id !== meta.resolve.root)
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? `파일: ${p.license_file}` : "(표기 없음)"),
      url: p.repository ?? p.homepage ?? "",
      dir: path.dirname(p.manifest_path),
    }));
}

/** Font and character map files pdf.js ships, each folder with its own license. */
function pdfjsAssets() {
  const dir = path.join(ROOT, "node_modules", "pdfjs-dist");
  const read = (...p) => fs.readFileSync(path.join(dir, ...p), "utf8").replace(/\r\n/g, "\n").trim();
  return [
    { name: "pdf.js 문자표 (cmaps)", text: read("cmaps", "LICENSE") },
    { name: "pdf.js 글꼴 (Foxit)", text: read("standard_fonts", "LICENSE_FOXIT") },
    { name: "pdf.js 글꼴 (Liberation)", text: read("standard_fonts", "LICENSE_LIBERATION") },
  ];
}

/** The text of a license kept in scripts/license-texts. */
function keptText(file) {
  return fs.readFileSync(path.join(TEXTS, file), "utf8").replace(/\r\n/g, "\n").trim();
}

const packages = [...npmPackages(), ...cargoPackages()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const byText = new Map();
const missing = [];
for (const p of packages) {
  const texts = KEPT_TEXT[p.name] ? [keptText(KEPT_TEXT[p.name])] : licenseTexts(path.join(p.dir, LICENSE_DIR[p.name] ?? ""));
  if (!texts.length) {
    missing.push(p);
    continue;
  }
  const text = texts.join("\n\n----\n\n");
  const key = createHash("sha256").update(text).digest("hex");
  if (!byText.has(key)) byText.set(key, { text, users: [] });
  byText.get(key).users.push(p);
}

const line = (p) => {
  const chosen = CHOSEN[p.name] ? `, ${CHOSEN[p.name]}로 사용` : "";
  return `  ${p.name} ${p.version} (${p.license}${chosen})${p.url ? ` ${p.url}` : ""}`;
};
const RULE = "=".repeat(78);
const parts = [
  `Notevine에 들어 있는 오픈소스 소프트웨어의 라이선스 고지입니다.
Notevine 자체는 MIT 라이선스이며 소스는 https://github.com/jinkyoin/notevine 에 있습니다.
MPL-2.0 패키지는 수정하지 않고 썼으며, 소스는 각 패키지 주소에서 받을 수 있습니다.
패키지 ${packages.length}개`,
];
for (const { text, users } of byText.values()) parts.push(`${RULE}\n${users.map(line).join("\n")}\n\n${text}`);
// KaTeX's package says MIT, but its font files are under the OFL (it is in each font's name table).
const assets = [...pdfjsAssets(), { name: "KaTeX 글꼴", text: keptText("katex-fonts.txt") }];
for (const a of assets) parts.push(`${RULE}\n  ${a.name}\n\n${a.text}`);
if (missing.length) {
  parts.push(`${RULE}\n패키지에 라이선스 파일이 들어 있지 않아 표기와 주소만 적습니다. 원문은 각 주소에서 볼 수 있습니다.\n\n${missing.map(line).join("\n")}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, parts.join("\n\n") + "\n");
console.log(`${path.relative(ROOT, OUT)}: 패키지 ${packages.length}개, 원문 ${byText.size}종, 원문 없음 ${missing.length}개, ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB`);
if (missing.length) console.log("원문 없음:", missing.map((p) => `${p.name}@${p.version}[${p.license}]`).join(", "));
if (process.argv.includes("--check") && missing.length) process.exit(1);
