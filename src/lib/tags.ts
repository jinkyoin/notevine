// `#태그` 자동완성 규칙. 무엇이 태그인지는 색인(parse.rs)의 규칙과 같다.

const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;
/** Characters that, right before `#`, make it part of a word, URL or path rather than a tag. */
const GLUED = /[\p{L}\p{N}_#&/\-\\:.]/u;

/**
 * The tag being typed at the end of `before` (the line up to the cursor): the text after
 * its `#`, possibly empty. Null when the `#` there doesn't start a tag.
 */
export function tagBefore(before: string): string | null {
  let i = before.length;
  while (i > 0 && TAG_CHAR.test(before[i - 1])) i--;
  if (i === 0 || before[i - 1] !== "#") return null;
  const prev = before[i - 2];
  if (prev !== undefined && !/\s/.test(prev) && GLUED.test(prev)) return null;
  // Inside an HTML tag (`<span style="color: #1c7ed6">`) a # is a color.
  const open = before.lastIndexOf("<", i);
  if (open >= 0 && open > before.lastIndexOf(">", i) && /^<\/?[A-Za-z!]/.test(before.slice(open))) return null;
  return before.slice(i);
}

/** Tags matching `query`: those starting with it first, then those containing it; most used first within each. */
export function rankTags<T extends { tag: string; count: number }>(tags: T[], query: string): T[] {
  const q = query.normalize("NFC").toLowerCase();
  const scored = tags.flatMap((t) => {
    const k = t.tag.normalize("NFC").toLowerCase();
    if (k === q) return [];
    const score = !q || k.startsWith(q) ? 0 : k.includes(q) ? 1 : -1;
    return score < 0 ? [] : [{ t, score }];
  });
  return scored.sort((a, b) => a.score - b.score || b.t.count - a.t.count || a.t.tag.localeCompare(b.t.tag, "ko")).map((x) => x.t);
}
