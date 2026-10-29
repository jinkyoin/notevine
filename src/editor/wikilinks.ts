// 위키링크: 표시(있는 노트=밑줄, 없는 노트=점선), Ctrl+클릭 이동, `[[` 자동완성.
// FR-LNK-01·02·04, SCR-04.
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { NoteRef } from "../api";
import { frontmatterEnd } from "./livePreview";

export interface LinkEnv {
  /** Path of the note being edited. */
  path(): string;
  notes(): NoteRef[];
  /** Opens a wiki target (a name or vault path), creating the note if needed; then goes to `heading`. */
  follow(target: string, heading: string | null): void;
  /** Opens a vault path from a markdown link, or an external URL. */
  openPath(path: string): void;
  openUrl(url: string): void;
  /** "click" follows links on a plain click (lines without the cursor); "ctrl" needs Ctrl. */
  clickMode(): "ctrl" | "click";
}

const FILE_EXT = /\.[a-z0-9]{1,8}$/i;
const isFileTarget = (t: string) => FILE_EXT.test(t) && !/\.md$/i.test(t);

/** Dispatch after the note list changes so link styles (exists / missing) refresh. */
export const refreshLinks = StateEffect.define<null>();

const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MDLINK = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;

export function linkKey(s: string): string {
  return s.normalize("NFC").trim().toLowerCase().replace(/\.md$/, "");
}

function splitTarget(inner: string) {
  const bar = inner.indexOf("|");
  const head = bar < 0 ? inner : inner.slice(0, bar);
  const hash = head.indexOf("#");
  return {
    target: (hash < 0 ? head : head.slice(0, hash)).trim(),
    heading: hash < 0 ? null : head.slice(hash + 1).trim() || null,
    targetLen: bar < 0 ? inner.length : bar, // length of "target#anchor"
    alias: bar < 0 ? null : inner.slice(bar + 1),
  };
}

function inCode(state: EditorState, pos: number): boolean {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "InlineCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

export function noteExists(notes: NoteRef[], target: string): boolean {
  const key = linkKey(target);
  if (!key) return false;
  return key.includes("/")
    ? notes.some((n) => linkKey(n.path) === key)
    : notes.some((n) => linkKey(n.title) === key);
}

const hide = Decoration.replace({});

function buildDecorations(view: EditorView, env: LinkEnv): DecorationSet {
  const { state } = view;
  const notes = env.notes();
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) active.add(n);
  }
  const out: Range<Decoration>[] = [];
  const fmEnd = frontmatterEnd(state);
  for (const { from, to } of view.visibleRanges) {
    for (let pos = Math.max(from, fmEnd); pos <= to; ) {
      const line = state.doc.lineAt(pos);
      const isActive = active.has(line.number);
      for (const m of line.text.matchAll(WIKI)) {
        const start = line.from + m.index!;
        if (inCode(state, start)) continue;
        const bang = m[1].length;
        const inner = m[2];
        const { target, heading, targetLen, alias } = splitTarget(inner);
        if (!target && !heading) continue;
        // Image embeds are drawn as previews by the attachments extension.
        if (bang && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(target)) continue;
        const cls = isFileTarget(target)
          ? "cm-wikilink cm-wikilink-file"
          : !target || noteExists(notes, target) // [[#제목]] is in this note
            ? "cm-wikilink"
            : "cm-wikilink cm-wikilink-missing";
        const how = env.clickMode() === "click" ? "클릭" : "Ctrl+클릭";
        const where = heading ? `${target || "이 노트"} › ${heading}` : target;
        const mark = Decoration.mark({ class: cls, attributes: { title: `${how}: ${where}` } });
        const innerFrom = start + bang + 2;
        const innerTo = innerFrom + inner.length;
        if (isActive) {
          out.push(mark.range(innerFrom, innerTo));
          continue;
        }
        out.push(hide.range(start, innerFrom)); // ![[  or  [[
        if (alias !== null && alias.length > 0) {
          out.push(hide.range(innerFrom, innerFrom + targetLen + 1)); // "target#anchor|"
          out.push(mark.range(innerFrom + targetLen + 1, innerTo));
        } else {
          out.push(mark.range(innerFrom, innerTo));
        }
        out.push(hide.range(innerTo, innerTo + 2)); // ]]
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

/** Link under a document position: a wiki target, or a markdown destination. */
export function linkAt(
  state: EditorState,
  pos: number,
): { kind: "wiki"; target: string; heading: string | null } | { kind: "md"; dest: string } | null {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  for (const m of line.text.matchAll(WIKI)) {
    if (col >= m.index! && col <= m.index! + m[0].length) {
      const { target, heading } = splitTarget(m[2]);
      return target || heading ? { kind: "wiki", target, heading } : null;
    }
  }
  for (const m of line.text.matchAll(MDLINK)) {
    if (col >= m.index! && col <= m.index! + m[0].length) {
      let dest = m[1].trim();
      if (dest.startsWith("<")) dest = dest.slice(1, dest.indexOf(">") < 0 ? undefined : dest.indexOf(">"));
      else dest = dest.split(/\s+"/)[0];
      return { kind: "md", dest };
    }
  }
  return null;
}

/** Resolves a relative markdown destination against the folder of `notePath`. */
export function resolveDest(notePath: string, dest: string): string | null {
  let d = dest.split("#")[0];
  try {
    d = decodeURIComponent(d);
  } catch {
    /* keep as written */
  }
  const parts = d.startsWith("/") ? [] : notePath.split("/").slice(0, -1);
  for (const seg of d.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg.normalize("NFC"));
  }
  return parts.join("/");
}

function completeNotes(env: LinkEnv) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[[^[\]|#\n]*$/);
    if (!m) return null;
    const query = m.text.slice(2);
    const q = linkKey(query);
    const notes = env.notes();
    const titleCount = new Map<string, number>();
    for (const n of notes) titleCount.set(linkKey(n.title), (titleCount.get(linkKey(n.title)) ?? 0) + 1);

    const ranked = notes
      .map((n) => {
        const t = linkKey(n.title);
        const p = linkKey(n.path);
        const score = !q ? 2 : t.startsWith(q) ? 0 : t.includes(q) ? 1 : p.includes(q) ? 2 : -1;
        return { n, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.n.title.length - b.n.title.length || a.n.title.localeCompare(b.n.title))
      .slice(0, 50);

    const closeAfter = (view: EditorView, pos: number) => (view.state.sliceDoc(pos, pos + 2) === "]]" ? "" : "]]");
    const options: Completion[] = ranked.map(({ n }) => {
      // Duplicate names need the path so the link stays unambiguous.
      const text = (titleCount.get(linkKey(n.title)) ?? 0) > 1 ? n.path.replace(/\.md$/i, "") : n.title;
      const folder = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
      return {
        label: n.title,
        detail: folder,
        apply: (view, _c, from, to) => {
          const insert = text + closeAfter(view, to);
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
        },
      };
    });
    if (query.trim() && !notes.some((n) => linkKey(n.title) === q)) {
      const name = query.trim();
      options.push({
        label: `＋ "${name}" 새 노트 만들기`,
        apply: (view, _c, from, to) => {
          const insert = name + closeAfter(view, to);
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
          env.follow(name, null);
        },
      });
    }
    return { from: m.from + 2, options, filter: false };
  };
}

export function wikiLinks(env: LinkEnv): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, env);
      }
      update(u: ViewUpdate) {
        if (u.view.composing) return;
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          u.transactions.some((t) => t.effects.some((e) => e.is(refreshLinks)))
        ) {
          this.decorations = buildDecorations(u.view, env);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const click = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0) return false;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod && env.clickMode() !== "click") return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) return false;
      // A plain click on the line being edited places the cursor as usual.
      if (!mod) {
        const line = view.state.doc.lineAt(pos).number;
        if (view.state.selection.ranges.some((r) => view.state.doc.lineAt(r.head).number === line)) return false;
      }
      const link = linkAt(view.state, pos);
      if (!link) return false;
      e.preventDefault();
      if (link.kind === "wiki") env.follow(link.target, link.heading);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(link.dest)) env.openUrl(link.dest);
      else {
        const p = resolveDest(env.path(), link.dest);
        if (p) env.openPath(p);
      }
      return true;
    },
  });

  return [
    plugin,
    click,
    autocompletion({ override: [completeNotes(env)], icons: false }),
    EditorView.baseTheme({
      ".cm-wikilink": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "3px", cursor: "pointer" },
      ".cm-wikilink-missing": { textDecorationStyle: "dashed", opacity: "0.8" },
      ".cm-wikilink-file": { textDecoration: "none", background: "var(--bg-sidebar)", border: "1px solid var(--border)", borderRadius: "4px", padding: "0 4px" },
      ".cm-wikilink-file::before": { content: '"📎 "' },
      ".cm-tooltip-autocomplete": { fontFamily: "var(--font)", border: "1px solid var(--border)", borderRadius: "6px" },
      ".cm-tooltip-autocomplete ul li": { padding: "4px 10px !important" },
      ".cm-completionDetail": { marginLeft: "12px", color: "var(--muted)", fontStyle: "normal", fontSize: "12px" },
    }),
  ];
}
