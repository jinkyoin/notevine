// 첨부 (FR-ATT-01·02·04): 파일 끌어 놓기·이미지 붙여넣기 → 첨부 폴더에 저장하고 링크 삽입,
// 커서가 없는 줄의 이미지 링크는 미리보기로 보여 준다.
import { type EditorState, type Extension, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { composingStep, frontmatterEnd } from "./livePreview";
import { resolveDest } from "./wikilinks";

import { tx } from "../i18n";
export interface AttachEnv {
  path(): string;
  folder(): string;
  save(name: string, data: Uint8Array): Promise<string>;
  /** Vault path of an embed target, or null. */
  resolve(target: string): Promise<string | null>;
  absPath(rel: string): Promise<string>;
  error(message: string): void;
  /** Link text for a vault file dragged from the file tree; null for a folder or a missing file. */
  linkTo(path: string): string | null;
}

/** What the file tree puts on a drag: the dragged entry's vault path. */
export const TREE_DRAG_TYPE = "application/x-notevine-path";

/**
 * The link for a vault file: a note by its name (with the folder only when another
 * note has the same name, as link completion does), an image as an embed, any other
 * file by its path.
 */
export function linkFor(path: string, notes: { path: string; title: string }[]): string {
  if (!/\.md$/i.test(path)) return attachmentLink(path);
  const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const key = title.normalize("NFC").toLowerCase();
  const same = notes.filter((n) => n.title.normalize("NFC").toLowerCase() === key).length;
  return `[[${same > 1 ? path.replace(/\.md$/i, "") : title}]]`;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const MAX_BYTES = 50 * 1024 * 1024;
const EMBED_WIKI = /!\[\[([^[\]\n|#]+?)(?:[#|][^[\]\n]*)?\]\]/g;
const EMBED_MD = /!\[[^\]\n]*\]\(([^)\n]+)\)/g;

export const refreshEmbeds = StateEffect.define<null>();

/** "이미지 20261028-143201.png" */
export function pastedImageName(now = new Date(), ext = "png"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return tx("이미지 {0}{1}{2}-{3}{4}{5}.{6}", now.getFullYear(), p(now.getMonth() + 1), p(now.getDate()), p(now.getHours()), p(now.getMinutes()), p(now.getSeconds()), ext);
}

/** Link text for a saved attachment: images embed, other files link. */
export function attachmentLink(rel: string): string {
  return IMAGE.test(rel) ? `![[${rel}]]` : `[[${rel}]]`;
}

async function saveFiles(view: EditorView, env: AttachEnv, files: File[], at: number) {
  const links: string[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      env.error(tx("\"{0}\"은(는) 50MB가 넘어 첨부하지 않았습니다", f.name));
      continue;
    }
    try {
      const rel = await env.save(f.name || pastedImageName(), new Uint8Array(await f.arrayBuffer()));
      links.push(attachmentLink(rel));
    } catch (e) {
      env.error(tx("\"{0}\"을(를) 첨부하지 못했습니다: {1}", f.name, String((e as { message?: string })?.message ?? e)));
    }
  }
  insertLinks(view, links, at);
}

/**
 * Where an inline link dropped at `col` of `text` goes: the nearer edge of the word
 * under the pointer, with a space added on a side that touches other text.
 */
export function inlineSpot(text: string, col: number): { col: number; before: string; after: string } {
  let at = Math.max(0, Math.min(col, text.length));
  if (at > 0 && at < text.length && /\S/.test(text[at - 1]) && /\S/.test(text[at])) {
    let l = at;
    while (l > 0 && /\S/.test(text[l - 1])) l--;
    let r = at;
    while (r < text.length && /\S/.test(text[r])) r++;
    at = at - l <= r - at ? l : r;
  }
  return { col: at, before: at > 0 && /\S/.test(text[at - 1]) ? " " : "", after: at < text.length && /\S/.test(text[at]) ? " " : "" };
}

/** Puts one link into the text where it was dropped (see inlineSpot). */
function insertInline(view: EditorView, link: string, at: number) {
  const line = view.state.doc.lineAt(Math.min(at, view.state.doc.length));
  const s = inlineSpot(line.text, at - line.from);
  const pos = line.from + s.col;
  const insert = s.before + link + s.after;
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + s.before.length + link.length }, userEvent: "input.drop" });
}

/** Puts links at `at`, each on its own line, without gluing them to the text around. */
function insertLinks(view: EditorView, links: string[], at: number) {
  if (!links.length) return;
  const pos = Math.min(at, view.state.doc.length);
  const line = view.state.doc.lineAt(pos);
  const before = pos > line.from ? "\n" : "";
  const after = pos < line.to ? "\n" : "";
  const insert = before + links.join("\n") + after;
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, userEvent: "input.attach" });
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-embed-img";
    img.src = this.src;
    img.alt = this.alt;
    img.draggable = false;
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

class MissingWidget extends WidgetType {
  constructor(readonly target: string) {
    super();
  }
  eq(o: MissingWidget) {
    return o.target === this.target;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-embed-missing";
    el.textContent = tx("이미지를 찾을 수 없음: {0}", this.target);
    return el;
  }
}

/** Each editor's attachment setup, for drops on the space around its text. */
const envOf = new WeakMap<EditorView, AttachEnv>();

/**
 * Files dropped anywhere on the editor's page (the margins, below the last line):
 * placed at the nearest text position, or at the end below the text. Returns false
 * when it isn't a file drop for this editor.
 */
export function dropFilesOn(view: EditorView | null, e: DragEvent): boolean {
  const env = view && envOf.get(view);
  if (!view || !env || e.defaultPrevented) return false;
  const below = e.clientY > view.contentDOM.getBoundingClientRect().bottom;
  const pos = below ? view.state.doc.length : (view.posAtCoords({ x: e.clientX, y: e.clientY }, false) ?? view.state.doc.length);
  return dropAt(view, env, e, pos, below);
}

/** A drop of a file-tree entry (a link to it) or of files from Windows Explorer (copied in). */
function dropAt(view: EditorView, env: AttachEnv, e: DragEvent, pos: number, ownLine = false): boolean {
  const treePath = e.dataTransfer?.getData(TREE_DRAG_TYPE);
  if (treePath) {
    e.preventDefault();
    const link = env.linkTo(treePath);
    // On the text: in the sentence. Below the text: a line of its own.
    if (link) (ownLine ? insertLinks(view, [link], pos) : insertInline(view, link, pos));
    else env.error(tx("폴더는 링크로 넣을 수 없습니다"));
    view.focus();
    return true;
  }
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return false;
  e.preventDefault();
  void saveFiles(view, env, files, pos);
  return true;
}

export function attachments(env: AttachEnv): Extension {
  // target → absolute file URL (or null when missing); filled asynchronously.
  const cache = new Map<string, string | null>();
  const pending = new Set<string>();

  const lookup = (view: EditorView, key: string, rel: () => Promise<string | null>) => {
    if (cache.has(key) || pending.has(key)) return cache.get(key);
    pending.add(key);
    rel()
      .then(async (r) => (r ? convertFileSrc(await env.absPath(r)) : null))
      .catch(() => null)
      .then((url) => {
        pending.delete(key);
        cache.set(key, url);
        view.dispatch({ effects: refreshEmbeds.of(null) });
      });
    return undefined;
  };

  const build = (view: EditorView): DecorationSet => {
    const { state } = view;
    const active = activeLines(state);
    const fmEnd = frontmatterEnd(state);
    const out: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
      for (let pos = Math.max(from, fmEnd); pos <= to; ) {
        const line = state.doc.lineAt(pos);
        pos = line.to + 1;
        if (active.has(line.number)) continue;
        const add = (start: number, len: number, target: string, key: string, rel: () => Promise<string | null>) => {
          if (!IMAGE.test(target)) return;
          const url = lookup(view, key, rel);
          if (url === undefined) return; // still resolving
          const widget = url ? new ImageWidget(url, target) : new MissingWidget(target);
          out.push(Decoration.replace({ widget }).range(line.from + start, line.from + start + len));
        };
        for (const m of line.text.matchAll(EMBED_WIKI)) {
          const target = m[1].trim();
          add(m.index!, m[0].length, target, `w:${target}`, () => env.resolve(target));
        }
        for (const m of line.text.matchAll(EMBED_MD)) {
          let dest = m[1].trim();
          dest = dest.startsWith("<") ? dest.slice(1, dest.indexOf(">") < 0 ? undefined : dest.indexOf(">")) : dest.split(/\s+"/)[0];
          if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) continue; // remote images are not loaded (no network use)
          const rel = resolveDest(env.path(), dest);
          if (rel) add(m.index!, m[0].length, rel, `m:${rel}`, async () => rel);
        }
      }
    }
    return Decoration.set(out, true);
  };

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      composed = false;
      constructor(view: EditorView) {
        this.decorations = build(view);
        envOf.set(view, env);
      }
      update(u: ViewUpdate) {
        const step = composingStep(u, this);
        if (step === "skip") return;
        if (step === "rebuild" || u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshEmbeds)))) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const handlers = EditorView.domEventHandlers({
    dragover(e) {
      const types = e.dataTransfer?.types ?? [];
      if (types.includes("Files") || types.includes(TREE_DRAG_TYPE)) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = types.includes(TREE_DRAG_TYPE) ? "link" : "copy";
        return true;
      }
      return false;
    },
    drop(e, view) {
      // Nearest place to the pointer, even between lines or past a line's end.
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false) ?? view.state.selection.main.head;
      return dropAt(view, env, e, pos);
    },
    paste(e, view) {
      const items = [...(e.clipboardData?.items ?? [])];
      const images = items.filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
      // Text alongside an image (e.g. from a browser) means a normal paste.
      if (!images.length || e.clipboardData?.getData("text/plain")) return false;
      e.preventDefault();
      const named = images.map((f, i) => {
        const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
        const base = pastedImageName(new Date(), ext);
        return new File([f], i ? base.replace(`.${ext}`, ` ${i}.${ext}`) : base, { type: f.type });
      });
      void saveFiles(view, env, named, view.state.selection.main.head);
      return true;
    },
  });

  return [
    plugin,
    handlers,
    EditorView.baseTheme({
      ".cm-embed-img": { display: "block", maxWidth: "100%", maxHeight: "480px", margin: "6px 0", borderRadius: "4px" },
      ".cm-embed-missing": {
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "4px",
        border: "1px dashed var(--danger)",
        color: "var(--danger)",
        fontSize: "12px",
      },
    }),
  ];
}

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  }
  return lines;
}
