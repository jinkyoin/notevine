// 앱 안 사용자 매뉴얼: docs/사용자매뉴얼.md를 앱에 묶어 두고 목차·제목 이동에 쓸 것을 만든다.
import text from "../../docs/사용자매뉴얼.md?raw";

export const MANUAL = text;

/**
 * The anchor GitHub gives a heading, which the manual's own links use:
 * "4. 노트 연결하기: 링크·태그·속성" → "4-노트-연결하기-링크태그속성".
 */
export function headingSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** The manual's chapters (## headings) for its table of contents. */
export function manualChapters(md: string = MANUAL): { title: string; slug: string }[] {
  const out: { title: string; slug: string }[] = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^## (.+)$/.exec(line.trimEnd());
    if (m && m[1] !== "목차") out.push({ title: m[1], slug: headingSlug(m[1]) });
  }
  return out;
}
