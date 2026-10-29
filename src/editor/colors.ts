// SCR-04 글자색·배경색: 마크다운에는 색 문법이 없어 `<span style="color: …">` HTML로 저장한다
// (Obsidian 등 다른 마크다운 앱에서도 색이 보인다). 편집기에서는 커서가 없는 줄의 태그를 숨기고 색으로 보여 준다.
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Range, type TransactionSpec } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { frontmatterEnd } from "./livePreview";

export type ColorProp = "color" | "background-color";

/** Mid-tone text colors that read on both the light and the dark theme. */
export const TEXT_COLORS = [
  { name: "빨강", value: "#e03131" },
  { name: "주황", value: "#e8590c" },
  { name: "갈색", value: "#a0522d" },
  { name: "초록", value: "#2f9e44" },
  { name: "파랑", value: "#1c7ed6" },
  { name: "보라", value: "#9c36b5" },
  { name: "분홍", value: "#d6336c" },
  { name: "회색", value: "#868e96" },
];

/** Translucent backgrounds, so the text color underneath works on both themes. */
export const BG_COLORS = [
  { name: "노랑", value: "rgba(255, 212, 59, 0.45)" },
  { name: "주황", value: "rgba(255, 146, 43, 0.35)" },
  { name: "빨강", value: "rgba(250, 82, 82, 0.3)" },
  { name: "초록", value: "rgba(64, 192, 87, 0.3)" },
  { name: "파랑", value: "rgba(51, 154, 240, 0.3)" },
  { name: "보라", value: "rgba(151, 117, 250, 0.3)" },
  { name: "분홍", value: "rgba(240, 101, 149, 0.3)" },
  { name: "회색", value: "rgba(134, 142, 150, 0.3)" },
];

const VALUE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;

/**
 * Keeps only `color` / `background-color` with a plain color value; null when
 * nothing is left. Anything else (urls, positions…) never reaches the page.
 */
export function safeStyle(style: string): string | null {
  const kept = style
    .split(";")
    .map((d) => {
      const i = d.indexOf(":");
      if (i < 0) return null;
      const prop = d.slice(0, i).trim().toLowerCase();
      const value = d.slice(i + 1).trim();
      return (prop === "color" || prop === "background-color" || prop === "background") && VALUE.test(value)
        ? `${prop === "background" ? "background-color" : prop}: ${value}`
        : null;
    })
    .filter(Boolean);
  return kept.length ? kept.join("; ") : null;
}

const openTag = (prop: ColorProp) => new RegExp(`<span style="${prop}:\\s*[^";]+;?">$`);
const fullWrap = (prop: ColorProp) => new RegExp(`^<span style="${prop}:\\s*[^";]+;?">([\\s\\S]*)</span>$`);
const innerWraps = (prop: ColorProp) => new RegExp(`<span style="${prop}:\\s*[^";]+;?">([^<]*)</span>`, "g");
/** Every `</span>` closes a `<span` opened inside the text itself. */
function balanced(s: string): boolean {
  let depth = 0;
  for (const m of s.matchAll(/<span\b|<\/span>/g)) {
    depth += m[0] === "</span>" ? -1 : 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Heading, list, task and quote markers stay outside the color span. */
const LINE_PREFIX = /^(#{1,6} |(>\s?)+|\s*([-*+] \[[ xX]\] |[-*+] |\d+[.)] ))/;

/**
 * Colors the selection (or the word at the cursor) with `value`, replacing a
 * color of the same kind already there; `value` null removes it. Each line is
 * wrapped on its own so lists and headings keep working.
 */
export function applyColor(state: EditorState, prop: ColorProp, value: string | null): TransactionSpec {
  const changes: { from: number; to: number; insert: string }[] = [];
  const ranges: { anchor: number; head: number }[] = [];
  let shift = 0;
  for (const range of state.selection.ranges) {
    let { from, to } = range;
    if (range.empty) {
      const word = state.wordAt(range.head);
      if (word) ({ from, to } = word);
    }
    // Split into lines.
    const pieces: [number, number][] = [];
    for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
      const line = state.doc.line(n);
      const prefix = LINE_PREFIX.exec(line.text)?.[0].length ?? 0;
      const a = Math.max(from, line.from + prefix);
      const b = Math.min(to, line.to);
      if (b > a || (from === to && a === b)) pieces.push([a, b]);
    }
    let selFrom = -1;
    let selTo = -1;
    for (let [a, b] of pieces) {
      let inner = state.sliceDoc(a, b);
      // Already inside a span of this kind: replace that span.
      const before = openTag(prop).exec(state.sliceDoc(Math.max(0, a - 80), a));
      if (before && state.sliceDoc(b, b + 7) === "</span>") {
        a -= before[0].length;
        b += 7;
      } else {
        const whole = fullWrap(prop).exec(inner);
        // Only when that span really encloses the whole selection, not "<span>a</span> <span>b</span>".
        if (whole && balanced(whole[1])) inner = whole[1];
      }
      inner = inner.replace(innerWraps(prop), "$1");
      const open = value ? `<span style="${prop}: ${value}">` : "";
      const insert = value ? `${open}${inner}</span>` : inner;
      changes.push({ from: a, to: b, insert });
      const start = a + shift + open.length;
      if (selFrom < 0) selFrom = start;
      selTo = start + inner.length;
      shift += insert.length - (b - a);
    }
    if (selFrom >= 0) ranges.push({ anchor: selFrom, head: selTo });
  }
  return {
    changes,
    selection: ranges.length
      ? EditorSelection.create(ranges.map((r) => EditorSelection.range(r.anchor, r.head)))
      : undefined,
    userEvent: "input.format",
    scrollIntoView: true,
  };
}

// ---------- showing colors in the editor ----------

const TAG = /<span style="([^"]*)">|<\/span>/g;
const hide = Decoration.replace({});

function inCode(state: EditorState, pos: number): boolean {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "InlineCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) active.add(n);
  }
  const fmEnd = frontmatterEnd(state);
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = Math.max(from, fmEnd); pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (!line.text.includes("<span")) continue;
      const isActive = active.has(line.number);
      const stack: { start: number; end: number; style: string | null }[] = [];
      for (const m of line.text.matchAll(TAG)) {
        const at = line.from + m.index!;
        if (inCode(state, at)) continue;
        if (m[1] !== undefined) {
          stack.push({ start: at, end: at + m[0].length, style: safeStyle(m[1]) });
          continue;
        }
        const open = stack.pop();
        if (!open?.style) continue;
        if (at > open.end) out.push(Decoration.mark({ attributes: { style: open.style } }).range(open.end, at));
        if (!isActive) {
          out.push(hide.range(open.start, open.end));
          out.push(hide.range(at, at + m[0].length));
        }
      }
    }
  }
  return Decoration.set(out, true);
}

export const colorSpans = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.view.composing) return; // keep the IME span stable (FR-EDT-05)
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
