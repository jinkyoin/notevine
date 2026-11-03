// SCR-04: frontmatter를 한 줄 요약으로 접어 보여 준다. 커서가 블록 안에 들어가면 YAML 원문을 편집한다.
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { readFrontmatter, splitFrontmatter } from "../lib/frontmatter";

import { tx } from "../i18n";
class SummaryWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly error: boolean,
  ) {
    super();
  }
  eq(o: SummaryWidget) {
    return o.text === this.text && o.error === this.error;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = this.error ? "cm-fm-summary error" : "cm-fm-summary";
    el.textContent = this.text;
    el.title = tx("클릭해서 YAML 편집");
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(4, view.state.doc.length) } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** Frontmatter never needs more than the start of the note; don't copy a 1 MB doc per keystroke. */
const HEAD = 65536;

function build(state: EditorState): DecorationSet {
  const text = state.sliceDoc(0, HEAD);
  const { yaml, bodyStart } = splitFrontmatter(text);
  if (yaml === null) return Decoration.none;
  // The block ends at the closing delimiter line; keep its trailing newline out.
  const end = state.doc.lineAt(Math.max(0, bodyStart - 1)).to;
  const out: Range<Decoration>[] = [];
  const sel = state.selection.main;
  const inside = sel.from <= end && sel.to >= 0 && sel.head <= end;
  if (inside) {
    for (let pos = 0; pos <= end; ) {
      const line = state.doc.lineAt(pos);
      out.push(Decoration.line({ class: "cm-fm-line" }).range(line.from));
      pos = line.to + 1;
    }
    return Decoration.set(out);
  }
  const fm = readFrontmatter(text);
  const summary = fm.error
    ? tx("속성 YAML 오류: {0}", fm.error)
    : fm.props.length === 0
      ? tx("속성 없음")
      : fm.props
          .slice(0, 4)
          .map((p) => `${p.key}: ${Array.isArray(p.value) ? p.value.join(", ") : String(p.value)}`)
          .join("   ·   ") + (fm.props.length > 4 ? tx("   ·   외 {0}개", fm.props.length - 4) : "");
  out.push(Decoration.replace({ widget: new SummaryWidget(summary, !!fm.error), block: true }).range(0, end));
  return Decoration.set(out);
}

export const frontmatterFold: Extension = [
  StateField.define<DecorationSet>({
    create: build,
    update(deco, tr) {
      if (!tr.docChanged && !tr.selection) return deco;
      // Typing far below the block (most edits in a long note) can't change it: just map the ranges.
      let touchesHead = false;
      tr.changes.iterChangedRanges((fromA) => {
        if (fromA < HEAD) touchesHead = true;
      });
      const far = (s: EditorState) => s.selection.main.from >= HEAD;
      if (!touchesHead && far(tr.startState) && far(tr.state)) return deco.map(tr.changes);
      return build(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  }),
  EditorView.baseTheme({
    ".cm-fm-summary": {
      fontFamily: "var(--font)",
      fontSize: "12px",
      color: "var(--muted)",
      background: "var(--bg-sidebar)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "3px 10px",
      margin: "2px 0 8px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    ".cm-fm-summary.error": { color: "var(--danger)", borderColor: "var(--danger)" },
    // Raw YAML: plain monospace, no markdown styling leaking in (e.g. setext headings).
    ".cm-fm-line, .cm-fm-line *": {
      fontFamily: "var(--mono) !important",
      fontSize: "13px !important",
      fontWeight: "normal !important",
      fontStyle: "normal !important",
      textDecoration: "none !important",
      color: "var(--muted)",
      lineHeight: "1.6 !important",
      paddingTop: "0 !important",
    },
    ".cm-fm-line": { background: "var(--bg-sidebar)" },
  }),
];
