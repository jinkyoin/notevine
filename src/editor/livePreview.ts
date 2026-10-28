// FR-EDT-02 라이브 미리보기: 커서가 없는 줄은 마크다운 기호를 숨기고 서식으로,
// 커서가 있는 줄은 원문 그대로 보여 준다.
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { splitFrontmatter } from "../lib/frontmatter";

/** End of the frontmatter block (0 when none); markdown styling starts after it. */
export function frontmatterEnd(state: EditorState): number {
  const { yaml, bodyStart } = splitFrontmatter(state.sliceDoc(0, 65536));
  return yaml === null ? 0 : bodyStart;
}

const hide = Decoration.replace({});

const inlineClass: Record<string, string> = {
  Emphasis: "cm-md-em",
  StrongEmphasis: "cm-md-strong",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-code",
  Link: "cm-md-link",
};

/** Marks hidden on lines without the cursor. */
const hiddenMarks = new Set(["HeaderMark", "EmphasisMark", "StrikethroughMark", "CodeMark", "LinkMark", "QuoteMark"]);

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-md-bullet";
    dot.textContent = "•";
    return dot;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });

class RuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-md-hr";
    return hr;
  }
}

function cursorLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

export function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const active = cursorLines(state);
  const out: Range<Decoration>[] = [];
  const onActiveLine = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const lineClass = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      out.push(Decoration.line({ class: cls }).range(line.from));
      pos = line.to + 1;
    }
  };

  const fmEnd = frontmatterEnd(state);
  // [[wiki links]] and ![[embeds]] belong to the wikilinks/attachments extensions;
  // markdown sees "[...]" inside them as a link and must not hide anything there.
  const wiki: [number, number][] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      for (const m of line.text.matchAll(/!?\[\[[^[\]\n]+?\]\]/g)) {
        wiki.push([line.from + m.index!, line.from + m.index! + m[0].length]);
      }
      pos = line.to + 1;
    }
  }
  const inWiki = (a: number, b: number) => wiki.some(([s, e]) => a >= s && b <= e);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: Math.max(from, fmEnd),
      to,
      enter: (node) => {
        if (node.from < fmEnd) return; // YAML block is shown raw (frontmatterFold)
        if (inWiki(node.from, node.to)) return false;
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(Decoration.line({ class: `cm-md-h cm-md-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
          return;
        }
        if (name === "FencedCode" || name === "CodeBlock") {
          lineClass(node.from, node.to, "cm-md-codeblock");
          return false; // keep code text and fences untouched
        }
        if (name === "Blockquote") {
          lineClass(node.from, node.to, "cm-md-quote");
          return;
        }
        if (name === "HorizontalRule") {
          if (!onActiveLine(node.from)) out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          return;
        }
        if (name === "TaskMarker") {
          if (!onActiveLine(node.from)) {
            const checked = state.sliceDoc(node.from + 1, node.from + 2).toLowerCase() === "x";
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
          }
          return;
        }
        const cls = inlineClass[name];
        if (cls && node.to > node.from) out.push(Decoration.mark({ class: cls }).range(node.from, node.to));

        if (onActiveLine(node.from)) return;
        if (hiddenMarks.has(name)) {
          let end = node.to;
          // "# " — hide the space after the heading marks too
          if (name === "HeaderMark" && state.sliceDoc(end, end + 1) === " ") end++;
          // "> " — same for quotes
          if (name === "QuoteMark" && state.sliceDoc(end, end + 1) === " ") end++;
          // a code fence's own ``` is a CodeMark too, but fences were skipped above
          if (end > node.from) out.push(hide.range(node.from, end));
        } else if (name === "URL" && node.node.parent?.name === "Link") {
          out.push(hide.range(node.from, node.to));
        } else if (name === "ListMark") {
          const mark = state.sliceDoc(node.from, node.to);
          if (node.node.parent?.parent?.name === "BulletList" && (mark === "-" || mark === "*" || mark === "+")) {
            out.push(bullet.range(node.from, node.to));
          }
        }
      },
    });
  }
  return Decoration.set(out, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      // While composing Korean text, keep decorations stable so the IME span isn't
      // redrawn mid-syllable (FR-EDT-05).
      if (u.view.composing) return;
      if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const livePreviewTheme = EditorView.baseTheme({
  ".cm-md-h": { fontWeight: "700", lineHeight: "1.4" },
  ".cm-md-h1": { fontSize: "1.7em", paddingTop: "0.4em" },
  ".cm-md-h2": { fontSize: "1.4em", paddingTop: "0.35em" },
  ".cm-md-h3": { fontSize: "1.2em", paddingTop: "0.3em" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontSize: "1.05em" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-strike": { textDecoration: "line-through", opacity: "0.7" },
  ".cm-md-code": {
    fontFamily: "var(--mono)",
    fontSize: "0.9em",
    background: "var(--bg-sidebar)",
    borderRadius: "3px",
    padding: "1px 3px",
  },
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "3px" },
  ".cm-md-codeblock": { fontFamily: "var(--mono)", fontSize: "0.9em", background: "var(--bg-sidebar)" },
  ".cm-md-quote": { borderLeft: "3px solid var(--border)", paddingLeft: "12px", color: "var(--muted)" },
  ".cm-md-bullet": { color: "var(--muted)", display: "inline-block", width: "0.6em", textAlign: "center" },
  ".cm-md-task": { margin: "0 6px 0 0", verticalAlign: "middle", cursor: "pointer", accentColor: "var(--accent)" },
  ".cm-md-hr": { border: "none", borderTop: "1px solid var(--border)", margin: "0.6em 0" },
});
