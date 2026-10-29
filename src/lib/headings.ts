// [[노트#제목]] 링크가 가리키는 제목 찾기. 코드 블록과 맨 위 속성(frontmatter) 안의 #은 제목이 아니다.
import { splitFrontmatter } from "./frontmatter";

/** Heading text as links compare it: no markdown marks, spaces collapsed, case ignored. */
export function headingKey(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[*_`~=]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 1-based line of the first ATX heading (`## 제목`) matching `heading`, or null. */
export function findHeadingLine(text: string, heading: string): number | null {
  const want = headingKey(heading);
  if (!want) return null;
  const { bodyStart } = splitFrontmatter(text);
  const lines = text.split(/\r?\n/);
  let fence: string | null = null;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = offset;
    offset += line.length + 1;
    if (start < bodyStart) continue;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^\s{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m && headingKey(m[1]) === want) return i + 1;
  }
  return null;
}
