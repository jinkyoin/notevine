// SCR-04 서식 막대: 굵게·제목·목록 같은 자주 쓰는 마크다운을 버튼·단축키로 넣고 뺀다.
// 모두 EditorState → TransactionSpec 순수 함수라 실행 취소(Ctrl+Z) 한 번으로 되돌아간다.
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { calloutHead, calloutMark, type CalloutType } from "../lib/callout";

const spec = (s: TransactionSpec): TransactionSpec => ({ ...s, userEvent: "input.format", scrollIntoView: true });

/**
 * Wraps each selection in `mark` (e.g. "**"), or unwraps it when it already is.
 * An empty selection takes the word around the cursor; with no word it inserts
 * the pair and puts the cursor between.
 */
export function toggleWrap(state: EditorState, mark: string, close = mark): TransactionSpec {
  const tr = state.changeByRange((range) => {
    let { from, to } = range;
    if (range.empty) {
      const word = state.wordAt(range.head);
      if (word) ({ from, to } = word);
    } else {
      // Markdown ignores a mark with a space on its inner side ("** 굵게**"), so spaces
      // at the edges of the selection stay outside the marks.
      const text = state.sliceDoc(from, to);
      const lead = text.length - text.trimStart().length;
      const trail = text.length - text.trimEnd().length;
      if (lead === text.length) from = to;
      else {
        from += lead;
        to -= trail;
      }
    }
    const before = state.sliceDoc(from - mark.length, from);
    const after = state.sliceDoc(to, to + close.length);
    // Already wrapped just outside the selection: remove the marks.
    if (from !== to && before === mark && after === close) {
      return {
        changes: [
          { from: from - mark.length, to: from },
          { from: to, to: to + close.length },
        ],
        range: EditorSelection.range(from - mark.length, to - mark.length),
      };
    }
    // The selection itself includes the marks: remove them.
    const text = state.sliceDoc(from, to);
    if (text.length >= mark.length + close.length && text.startsWith(mark) && text.endsWith(close)) {
      const inner = text.slice(mark.length, text.length - close.length);
      return { changes: { from, to, insert: inner }, range: EditorSelection.range(from, from + inner.length) };
    }
    return {
      changes: [
        { from, insert: mark },
        { from: to, insert: close },
      ],
      range:
        from === to
          ? EditorSelection.cursor(from + mark.length)
          : EditorSelection.range(from + mark.length, to + mark.length),
    };
  });
  return spec(tr);
}

export type LineKind = "h1" | "h2" | "h3" | "bullet" | "number" | "task" | "quote";

const PREFIX_RE: Record<LineKind, RegExp> = {
  h1: /^# /,
  h2: /^## /,
  h3: /^### /,
  bullet: /^(\s*)[-*+] (?!\[[ xX]\] )/,
  number: /^(\s*)\d+[.)] /,
  task: /^(\s*)[-*+] \[[ xX]\] /,
  quote: /^> ?/,
};

/** Any heading, list or quote marker at the start of a line (what a new marker replaces). */
const ANY_PREFIX = /^(#{1,6} |>\s?|(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] ))/;

/**
 * Turns the selected lines into headings / list items / quotes, or back to
 * plain text when they all already are. Replaces another marker in place.
 */
export function toggleLines(state: EditorState, kind: LineKind): TransactionSpec {
  const lines: { from: number; text: string }[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const l = state.doc.line(n);
      lines.push({ from: l.from, text: l.text });
    }
  }
  // Blank lines inside a multi-line selection stay blank.
  const target = lines.length > 1 ? lines.filter((l) => l.text.trim()) : lines;
  const all = target.length > 0 && target.every((l) => PREFIX_RE[kind].test(l.text));
  let n = 0;
  const changes = target.map((l) => {
    const old = ANY_PREFIX.exec(l.text);
    const indent = old?.[2] ?? /^\s*/.exec(l.text)![0];
    const oldLen = old ? old[0].length : indent.length;
    if (all) return { from: l.from, to: l.from + oldLen, insert: indent };
    n++;
    const insert =
      kind === "h1"
        ? "# "
        : kind === "h2"
          ? "## "
          : kind === "h3"
            ? "### "
            : kind === "quote"
              ? "> "
              : indent + (kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : `${n}. `);
    return { from: l.from, to: l.from + oldLen, insert };
  });
  return spec({ changes });
}

/** Inserts a block on its own lines at the cursor (blank line before/after as needed). */
export function insertBlock(state: EditorState, block: string, cursorOffset = block.length): TransactionSpec {
  const r = state.selection.main;
  const line = state.doc.lineAt(r.from);
  const atStart = r.from === line.from && !line.text.trim();
  const before = atStart ? "" : r.from === line.from ? "" : "\n\n";
  const at = atStart ? line.from : r.from === line.from ? line.from : r.to;
  const insert = before + block + "\n";
  return spec({
    changes: { from: at, to: atStart ? line.to : at, insert },
    selection: EditorSelection.cursor(at + before.length + cursorOffset),
  });
}

/** Fenced code block around the selection, or an empty one with the cursor inside. */
export function codeBlock(state: EditorState): TransactionSpec {
  const r = state.selection.main;
  if (r.empty) return insertBlock(state, "```\n\n```", 4);
  const from = state.doc.lineAt(r.from).from;
  const to = state.doc.lineAt(r.to).to;
  const text = state.sliceDoc(from, to);
  return spec({ changes: { from, to, insert: "```\n" + text + "\n```" }, selection: EditorSelection.cursor(from + 4 + text.length) });
}

/** `[[selection]]`, or `[[]]` with the cursor inside (autocomplete then suggests notes). */
export function wikiLink(state: EditorState): TransactionSpec {
  return toggleWrap(state, "[[", "]]");
}

/** `[selection](url)` with "url" selected, ready to paste over. */
export function webLink(state: EditorState): TransactionSpec {
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to) || "링크";
  const insert = `[${text}](url)`;
  const urlAt = r.from + text.length + 3;
  return spec({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.range(urlAt, urlAt + 3) });
}

/**
 * Puts the selected lines (or the cursor's line) in a `> [!중요]` box. On a box's
 * first line: another type changes the marker, the same type takes the box away.
 * On an empty line: an empty box with the cursor inside.
 */
export function callout(state: EditorState, type: CalloutType): TransactionSpec {
  const r = state.selection.main;
  const first = state.doc.lineAt(r.from);
  const last = state.doc.lineAt(r.to);
  const mark = calloutMark(type);
  const quote = /^\s*>\s?/.exec(first.text);
  const head = quote && calloutHead(first.text.slice(quote[0].length));
  if (head) {
    const at = first.from + quote[0].length;
    if (head.type.kind !== type.kind) return spec({ changes: { from: at, to: at + head.markLen, insert: mark } });
    // Same type: unwrap. A title stays as the first line; without one the line goes.
    const changes = [];
    if (head.title) changes.push({ from: first.from, to: at + head.markLen + 1 });
    else changes.push({ from: first.from, to: Math.min(first.to + 1, state.doc.length) });
    for (let n = first.number + 1; n <= state.doc.lines; n++) {
      const l = state.doc.line(n);
      const q = /^\s*>\s?/.exec(l.text);
      if (!q) break;
      changes.push({ from: l.from, to: l.from + q[0].length });
    }
    return spec({ changes });
  }
  if (r.empty && !first.text.trim()) {
    const insert = `> ${mark}\n> `;
    return spec({ changes: { from: first.from, to: first.to, insert }, selection: EditorSelection.cursor(first.from + insert.length) });
  }
  const lines: string[] = [];
  for (let n = first.number; n <= last.number; n++) {
    const t = state.doc.line(n).text;
    lines.push(t.trim() ? `> ${t.replace(/^>\s?/, "")}` : ">");
  }
  const insert = `> ${mark}\n${lines.join("\n")}`;
  return spec({ changes: { from: first.from, to: last.to, insert }, selection: EditorSelection.cursor(first.from + insert.length) });
}

export const TABLE ="| 항목 | 내용 |\n| --- | --- |\n|  |  |";
