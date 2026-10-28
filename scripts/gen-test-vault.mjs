// 성능 측정용 테스트 볼트를 만든다 (NFR-PRF-01~04).
// 사용: node scripts/gen-test-vault.mjs <출력 폴더> [노트 수=10000]
// 한글 본문 1~3KB, frontmatter(type·status·tags·created), 위키링크·태그가 섞인 노트와
// 1MB짜리 큰 노트 하나(big-note.md)를 만든다. 같은 시드면 같은 볼트가 나온다.
import fs from "node:fs";
import path from "node:path";

const [out, countArg] = process.argv.slice(2);
if (!out) {
  console.error("사용: node scripts/gen-test-vault.mjs <출력 폴더> [노트 수]");
  process.exit(1);
}
const COUNT = Number(countArg ?? 10000);

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rand() * a.length)];

const words = (
  "업무 개선 회의 보고 자동화 일정 검토 아이디어 자료 조사 결과 정리 기록 고객 요청 프로젝트 " +
  "배포 테스트 설계 문서 요구사항 화면 검색 링크 히스토리 템플릿 속성 태그 백링크 동기화 " +
  "주간 월간 회고 목표 지표 성과 위험 대응 일정표 담당자 결정 사항 후속 조치 참고 출처"
).split(" ");
const folders = ["00 Inbox", "10 업무일지/2025", "10 업무일지/2026", "20 아이디어", "30 조사자료", "40 프로젝트/알파", "40 프로젝트/베타", "50 회의록"];
const types = ["journal", "idea", "research", "meeting"];
const statuses = ["아이디어", "검토", "진행", "완료", "보류"];
const tags = ["업무개선", "자동화", "회고", "고객", "프로젝트/알파", "프로젝트/베타", "보고", "조사"];

function sentence() {
  const n = 6 + Math.floor(rand() * 10);
  return Array.from({ length: n }, () => pick(words)).join(" ") + ".";
}

function body(i, titles) {
  const target = 1000 + Math.floor(rand() * 2000); // 1–3 KB of UTF-8 (Korean ≈ 3 bytes/char)
  const lines = [`# ${titles[i]}`, ""];
  let size = 0;
  while (size < target) {
    let line = sentence();
    if (rand() < 0.15) line += ` [[${pick(titles)}]]`;
    if (rand() < 0.1) line += ` #${pick(tags)}`;
    lines.push(rand() < 0.2 ? `- ${line}` : line);
    size += Buffer.byteLength(line);
  }
  return lines.join("\n") + "\n";
}

fs.mkdirSync(out, { recursive: true });
const titles = Array.from({ length: COUNT }, (_, i) => `${pick(words)} ${pick(words)} ${String(i).padStart(5, "0")}`);
let bytes = 0;
for (let i = 0; i < COUNT; i++) {
  const dir = path.join(out, folders[i % folders.length]);
  fs.mkdirSync(dir, { recursive: true });
  const day = String(1 + (i % 28)).padStart(2, "0");
  const fm = [
    "---",
    `type: ${types[i % types.length]}`,
    `status: ${pick(statuses)}`,
    `tags: [${pick(tags)}, ${pick(tags)}]`,
    `created: 2026-${String(1 + (i % 10)).padStart(2, "0")}-${day}`,
    "---",
    "",
  ].join("\n");
  const text = fm + body(i, titles);
  bytes += Buffer.byteLength(text);
  fs.writeFileSync(path.join(dir, `${titles[i]}.md`), text);
}

// 1 MB notes for the typing-latency check (NFR-PRF-04): one written like a long
// journal (headings, paragraphs, lists), and a worst case with no blank lines at all,
// which markdown treats as a single 1 MB paragraph.
function bigNote(paragraphs) {
  const lines = ["# 큰 노트", ""];
  let size = 0;
  for (let i = 0; size < 1024 * 1024; i++) {
    if (paragraphs && i % 40 === 0) lines.push(`## ${i / 40 + 1}일 차 기록`, "");
    const line = (paragraphs && i % 3 === 0 ? "- " : "") + sentence() + " " + sentence();
    lines.push(line);
    if (paragraphs && i % 5 === 4) lines.push("");
    size += Buffer.byteLength(line) + 1;
  }
  return { text: lines.join("\n") + "\n", size };
}
const big = bigNote(true);
fs.writeFileSync(path.join(out, "big-note.md"), big.text);
fs.writeFileSync(path.join(out, "big-paragraph.md"), bigNote(false).text);
const bigSize = big.size;

console.log(`노트 ${COUNT}개 (${(bytes / 1024 / 1024).toFixed(1)}MB) + big-note.md (${(bigSize / 1024 / 1024).toFixed(1)}MB) → ${out}`);
