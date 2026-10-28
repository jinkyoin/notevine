// 첨부 (FR-ATT-01·02·04): 파일 끌어 놓기·이미지 붙여넣기 → 첨부 폴더에 저장하고 링크 삽입,
// 커서가 없는 줄의 이미지 링크는 미리보기로 보여 준다.
import { type EditorState, type Extension, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { frontmatterEnd } from "./livePreview";
import { resolveDest } from "./wikilinks";

export interface AttachEnv {
  path(): string;
  folder(): string;
  save(name: string, data: Uint8Array): Promise<string>;
  /** Vault path of an embed target, or null. */
  resolve(target: string): Promise<string | null>;
  absPath(rel: string): Promise<string>;
  error(message: string): void;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const MAX_BYTES = 50 * 1024 * 1024;
const EMBED_WIKI = /!\[\[([^[\]\n|#]+?)(?:[#|][^[\]\n]*)?\]\]/g;
const EMBED_MD = /!\[[^\]\n]*\]\(([^)\n]+)\)/g;

export const refreshEmbeds = StateEffect.define<null>();

/** "이미지 20261028-143201.png" */
export function pastedImageName(now = new Date(), ext = "png"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `이미지 ${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

/** Link text for a saved attachment: images embed, other files link. */
export function attachmentLink(rel: string): string {
  return IMAGE.test(rel) ? `![[${rel}]]` : `[[${rel}]]`;
}

async function saveFiles(view: EditorView, env: AttachEnv, files: File[], at: number) {
  const links: string[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      env.error(`"${f.name}"은(는) 50MB가 넘어 첨부하지 않았습니다`);
      continue;
    }
    try {
      const rel = await env.save(f.name || pastedImageName(), new Uint8Array(await f.arrayBuffer()));
      links.push(attachmentLink(rel));
    } catch (e) {
      env.error(`"${f.name}"을(를) 첨부하지 못했습니다: ${String((e as { message?: string })?.message ?? e)}`);
    }
  }
  if (!links.length) return;
  const insert = links.join("\n");
  const pos = Math.min(at, view.state.doc.length);
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
    el.textContent = `이미지를 찾을 수 없음: ${this.target}`;
    return el;
  }
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
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.view.composing) return;
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshEmbeds)))) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const handlers = EditorView.domEventHandlers({
    dragover(e) {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        return true;
      }
      return false;
    },
    drop(e, view) {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return false;
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      void saveFiles(view, env, files, pos);
      return true;
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
