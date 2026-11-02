// PDF 주석 (FR-ATT-03): PDF 파일은 그대로 두고, 고른 글과 메모를 옆의 "이름 주석.md" 노트에 쌓는다.
// 주석 하나는 "> [!참고] [[문서.pdf#page=3|p.3]]" 상자로, 누르면 PDF의 그 쪽이 열린다.

const PAGE_LINK = /\[\[([^\]|#]+\.pdf)#page=(\d+)(?:\|[^\]]*)?\]\]/i;

/** The note that holds a PDF's annotations: next to it, "<name> 주석.md". */
export function annotationPath(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, "") + " 주석.md";
}

/** A new annotation note for `pdfPath`. */
export function annotationNote(pdfPath: string, today: string): string {
  const name = pdfPath.split("/").pop()!.replace(/\.pdf$/i, "");
  return `---\ntype: pdf-annotation\nsource: "[[${pdfPath}]]"\ncreated: ${today}\n---\n\n# ${name} 주석\n\n[[${pdfPath}]]\n`;
}

/** One annotation: the chosen text quoted in a box that links to its page, then the memo. */
export function annotationEntry(pdfPath: string, page: number, quote: string, memo: string): string {
  const lines = quote
    .replace(/\s+/g, " ")
    .trim()
    .match(/.{1,200}(\s|$)/g)!
    .map((l) => `> ${l.trim()}`);
  const body = memo.trim() ? `\n${memo.trim()}\n` : "";
  return `\n> [!참고] [[${pdfPath}#page=${page}|p.${page}]]\n${lines.join("\n")}\n${body}`;
}

export interface Annotation {
  page: number;
  quote: string;
  memo: string;
}

/** The annotations in an annotation note, in the order written. */
export function parseAnnotations(text: string): Annotation[] {
  const out: Annotation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^>\s*\[![^\]]+\]\s*(.*)$/.exec(lines[i]);
    const link = head && PAGE_LINK.exec(head[1]);
    if (!link) continue;
    const quote: string[] = [];
    let j = i + 1;
    for (; j < lines.length && /^>/.test(lines[j]); j++) quote.push(lines[j].replace(/^>\s?/, ""));
    const memo: string[] = [];
    for (; j < lines.length && !/^>\s*\[!/.test(lines[j]) && !/^#{1,6} /.test(lines[j]); j++) memo.push(lines[j]);
    out.push({ page: Number(link[2]), quote: quote.join(" ").trim(), memo: memo.join("\n").trim() });
    i = j - 1;
  }
  return out;
}

/**
 * Which of a page's text pieces (in order) the quote covers, for highlighting.
 * Spaces are ignored on both sides, since the PDF splits and spaces text its own way.
 */
export function quoteSpans(pieces: string[], quote: string): number[] {
  const want = quote.replace(/\s+/g, "");
  if (want.length < 2) return [];
  let joined = "";
  const owner: number[] = [];
  pieces.forEach((p, i) => {
    for (const ch of p.replace(/\s+/g, "")) {
      joined += ch;
      owner.push(i);
    }
  });
  const at = joined.indexOf(want);
  if (at < 0) return [];
  return [...new Set(owner.slice(at, at + want.length))];
}
