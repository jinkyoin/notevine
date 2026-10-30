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

/** Headings in the body: 0-based line, level and text. Not in frontmatter or code fences. */
function headings(text: string): { line: number; level: number; text: string }[] {
  const { bodyStart } = splitFrontmatter(text);
  const lines = text.split(/\r?\n/);
  const out: { line: number; level: number; text: string }[] = [];
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
    const m = /^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m) out.push({ line: i, level: m[1].length, text: m[2] });
  }
  return out;
}

/** 1-based line of the first ATX heading (`## 제목`) matching `heading`, or null. */
export function findHeadingLine(text: string, heading: string): number | null {
  const want = headingKey(heading);
  if (!want) return null;
  const h = headings(text).find((h) => headingKey(h.text) === want);
  return h ? h.line + 1 : null;
}

/**
 * The part of the note under `heading` (`![[노트#제목]]`): the heading line and everything
 * up to the next heading of the same or a higher level. Null when there is no such heading.
 */
export function noteSection(text: string, heading: string): string | null {
  const want = headingKey(heading);
  if (!want) return null;
  const all = headings(text);
  const i = all.findIndex((h) => headingKey(h.text) === want);
  if (i < 0) return null;
  const end = all.slice(i + 1).find((h) => h.level <= all[i].level);
  const lines = text.split(/\r?\n/);
  return lines.slice(all[i].line, end ? end.line : lines.length).join("\n").trimEnd();
}
