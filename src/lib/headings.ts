// [[노트#제목]]·[[노트#^블록]] 링크가 가리키는 곳 찾기. 코드 블록과 맨 위 속성(frontmatter) 안의 #은 제목이 아니다.
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

/** Body lines (0-based) outside frontmatter and code fences; fence lines themselves are left out. */
function bodyLines(text: string): { line: number; text: string }[] {
  const { bodyStart } = splitFrontmatter(text);
  const lines = text.split(/\r?\n/);
  const out: { line: number; text: string }[] = [];
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
    if (fence === null) out.push({ line: i, text: line });
  }
  return out;
}

const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** Headings in the body: 0-based line, level and text. Not in frontmatter or code fences. */
export function noteHeadings(text: string): { line: number; level: number; text: string }[] {
  return bodyLines(text).flatMap(({ line, text }) => {
    const m = HEADING.exec(text);
    return m ? [{ line, level: m[1].length, text: m[2] }] : [];
  });
}

/** 1-based line of the first ATX heading (`## 제목`) matching `heading`, or null. */
export function findHeadingLine(text: string, heading: string): number | null {
  const want = headingKey(heading);
  if (!want) return null;
  const h = noteHeadings(text).find((h) => headingKey(h.text) === want);
  return h ? h.line + 1 : null;
}

/**
 * The part of the note under `heading` (`![[노트#제목]]`): the heading line and everything
 * up to the next heading of the same or a higher level. Null when there is no such heading.
 */
export function noteSection(text: string, heading: string): string | null {
  const want = headingKey(heading);
  if (!want) return null;
  const all = noteHeadings(text);
  const i = all.findIndex((h) => headingKey(h.text) === want);
  if (i < 0) return null;
  const end = all.slice(i + 1).find((h) => h.level <= all[i].level);
  const lines = text.split(/\r?\n/);
  return lines.slice(all[i].line, end ? end.line : lines.length).join("\n").trimEnd();
}

// ---------- block links: [[노트#^id]] ----------

/** A block id ends its line: "문단 내용 ^a1b2c3". */
const BLOCK_ID = /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/;

/** 1-based line ending with `^id`, or null. */
export function findBlockLine(text: string, id: string): number | null {
  const want = id.replace(/^\^/, "").toLowerCase();
  const hit = bodyLines(text).find((l) => BLOCK_ID.exec(l.text)?.[1].toLowerCase() === want);
  return hit ? hit.line + 1 : null;
}

/**
 * The block `^id` marks (`![[노트#^id]]`): its line and the lines of the same paragraph
 * above it, without the id. Null when there is no such block.
 */
export function noteBlock(text: string, id: string): string | null {
  const at = findBlockLine(text, id);
  if (at === null) return null;
  const lines = text.split(/\r?\n/);
  let from = at - 1;
  // A list item or heading is a block of its own; a plain paragraph runs up to a blank line.
  const own = (l: string) => /^\s*([-*+]|\d+[.)])\s|^\s{0,3}#/.test(l);
  if (!own(lines[from])) while (from > 0 && lines[from - 1].trim() && !own(lines[from - 1]) && !/^\s*(`{3,}|~{3,}|---)/.test(lines[from - 1])) from--;
  return [...lines.slice(from, at - 1), lines[at - 1].replace(BLOCK_ID, "")].join("\n");
}

export interface BlockCandidate {
  /** 0-based line. */
  line: number;
  /** The line's text, without list marks or its id. */
  text: string;
  id: string | null;
}

/** Lines a block link can point at: non-empty body lines that are not headings or table rules. */
export function blockCandidates(text: string): BlockCandidate[] {
  return bodyLines(text).flatMap(({ line, text }) => {
    if (!text.trim() || HEADING.test(text) || /^\s*\|?[\s:|-]+\|?\s*$/.test(text) || /^\s*(-{3,}|\*{3,})\s*$/.test(text)) return [];
    const id = BLOCK_ID.exec(text)?.[1] ?? null;
    const plain = text
      .replace(BLOCK_ID, "")
      .replace(/^\s*(>\s*)*([-*+]|\d+[.)])?\s*(\[[ xX]\]\s*)?/, "")
      .trim();
    return plain ? [{ line, text: plain, id }] : [];
  });
}

/** A short id not used in `text`. */
export function newBlockId(text: string, random = Math.random): string {
  for (;;) {
    const id = random().toString(36).slice(2, 8).padEnd(6, "0");
    if (findBlockLine(text, id) === null) return id;
  }
}

/** Adds ` ^id` to the end of a line (0-based); a line that has an id keeps it. */
export function withBlockId(text: string, line: number, id: string): string {
  const lines = text.split("\n");
  if (line < 0 || line >= lines.length || BLOCK_ID.test(lines[line].replace(/\r$/, ""))) return text;
  const cr = lines[line].endsWith("\r") ? "\r" : "";
  lines[line] = lines[line].replace(/\r$/, "").trimEnd() + ` ^${id}` + cr;
  return lines.join("\n");
}
