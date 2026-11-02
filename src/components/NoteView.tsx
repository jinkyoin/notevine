// SCR-04 읽기 모드: 서식이 적용된 노트. 링크·태그·체크박스는 눌러서 쓸 수 있다.
import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { useApp } from "../store";
import type { NoteRef } from "../api";
import { noteToHtml } from "../lib/renderNote";
import { noteExists, resolveDest } from "../editor/wikilinks";
import { safeStyle } from "../editor/colors";
import { headingKey, noteBlock, noteSection } from "../lib/headings";
import { drawRichBlocks } from "../lib/richBlocks";

// Text/background colors (SCR-04) are the only styles kept; anything else, urls
// included, is dropped so the page can't load from the network.
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "style") return;
  const s = safeStyle(data.attrValue);
  if (s) data.attrValue = s;
  else data.keepAttr = false;
});

/** Sanitized HTML. Nothing in it may load from the network: `src` comes only from us. */
function safeHtml(text: string): string {
  return DOMPurify.sanitize(noteToHtml(text), {
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["src", "srcset", "action", "formaction", "background", "poster"],
  });
}

/** Embeds inside embeds go this deep; past that (or in a loop) the link is left as it is. */
const MAX_EMBED_DEPTH = 3;

/** Marks links to notes that don't exist yet. */
function markLinks(root: HTMLElement, notes: NoteRef[]) {
  root.querySelectorAll<HTMLAnchorElement>("a.wikilink[data-target]").forEach((a) => {
    const t = a.dataset.target!;
    if (!t) return; // [[#제목]]: a heading in this note
    const file = /\.[a-z0-9]{1,8}$/i.test(t) && !/\.md$/i.test(t);
    a.classList.toggle("unresolved", !file && !noteExists(notes, t));
  });
}

/** Fills in local images; `from` is the note their paths are relative to. */
function fillImages(root: HTMLElement, from: string, live: () => boolean) {
  root.querySelectorAll<HTMLImageElement>("img[data-embed]").forEach((img) => {
    const target = img.dataset.embed!;
    const rel = img.dataset.md ? Promise.resolve(resolveDest(from, target)) : api.resolveAttachment(target, from);
    rel
      .then(async (r) => (r ? convertFileSrc(await api.attachmentPath(r)) : null))
      .catch(() => null)
      .then((url) => {
        if (!live()) return;
        if (url) img.src = url;
        else img.replaceWith(Object.assign(document.createElement("span"), { className: "missing", textContent: `첨부 없음: ${target}` }));
      });
  });
}

const embedNote = (text: string) => Object.assign(document.createElement("span"), { className: "note-embed-note", textContent: text });

/**
 * ![[노트]] / ![[노트#제목]] (FR-LNK-07): puts the note (or that heading's section) under its
 * link, read-only. `chain` holds the embeds we are inside, to stop loops.
 */
async function fillEmbeds(
  root: HTMLElement,
  from: string,
  chain: string[],
  ctx: { openPath: string; openText: string; notes: NoteRef[]; live: () => boolean },
) {
  const spans = [...root.querySelectorAll<HTMLElement>("span.note-embed")];
  await Promise.all(
    spans.map(async (span) => {
      const target = span.dataset.noteEmbed ?? "";
      const heading = span.dataset.heading ?? null;
      const found = target ? await api.resolveLink(target).catch(() => null) : from;
      if (!ctx.live() || !found) return;
      const key = `${found}#${heading ?? ""}`;
      if (chain.includes(key) || chain.length > MAX_EMBED_DEPTH) {
        span.append(embedNote(chain.includes(key) ? "이미 위에서 보여주고 있는 노트라 링크로만 둡니다" : "임베드가 너무 깊어 링크로만 둡니다"));
        return;
      }
      const text = found === ctx.openPath ? ctx.openText : await api.readNote(found).catch(() => null);
      if (!ctx.live() || text === null) return;
      const block = !!heading?.startsWith("^");
      const part = heading ? (block ? noteBlock(text, heading) : noteSection(text, heading)) : text;
      if (part === null) {
        span.append(embedNote(`'${heading}' ${block ? "블록" : "제목"}을 찾지 못했습니다`));
        return;
      }
      const body = document.createElement("div");
      body.className = "note-embed-body";
      body.dataset.from = found;
      body.innerHTML = safeHtml(part);
      // Read-only: its tasks belong to the other note. [[#제목]] inside points at that note.
      body.querySelectorAll<HTMLInputElement>("input.task").forEach((t) => (t.disabled = true));
      body.querySelectorAll<HTMLAnchorElement>('a.wikilink[data-target=""]').forEach((a) => (a.dataset.target = found));
      span.append(body);
      markLinks(body, ctx.notes);
      fillImages(body, found, ctx.live);
      void drawRichBlocks(body, ctx.live);
      await fillEmbeds(body, found, [...chain, key], ctx);
    }),
  );
}

/** Last jump scrolled to, kept across read-mode toggles so a jump is followed only once. */
let scrolledSeq = 0;

export function NoteView({ path, text, onToggleTask }: { path: string; text: string; onToggleTask: (index: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const html = useMemo(() => safeHtml(text), [text]);
  const notes = useApp((s) => s.notes);

  // Mark links to notes that don't exist yet; fill in local images and embedded notes.
  // Embedded notes are re-read after each save so an edit elsewhere shows up here.
  const savedSeq = useApp((s) => s.savedSeq);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let live = true;
    const isLive = () => live;
    // A re-run on the same HTML (after a save) fills the embeds afresh.
    el.querySelectorAll(".note-embed-body, .note-embed-note").forEach((b) => b.remove());
    markLinks(el, notes);
    fillImages(el, path, isLive);
    void fillEmbeds(el, path, [`${path}#`], { openPath: path, openText: text, notes, live: isLive });
    return () => {
      live = false;
    };
    // `text` is left out: `html` changes with it.
  }, [html, notes, path, savedSeq]);

  // Formulas and Mermaid diagrams (FR-EDT-08), drawn after sanitizing.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let live = true;
    void drawRichBlocks(el, () => live);
    return () => {
      live = false;
    };
  }, [html]);

  // [[노트#제목]]: scroll to the heading once the note is shown.
  const jumpSeq = useApp((s) => s.jumpSeq);
  useEffect(() => {
    const { jumpHeading, openPath } = useApp.getState();
    if (jumpSeq === scrolledSeq || !jumpHeading || openPath !== path || !box.current) return;
    scrolledSeq = jumpSeq;
    if (jumpHeading.startsWith("^")) {
      // A block: the paragraph or list item holding its marker.
      const id = jumpHeading.slice(1).toLowerCase();
      const mark = [...box.current.querySelectorAll<HTMLElement>("[data-block]")].find((e) => !e.closest(".note-embed-body") && e.dataset.block === id);
      const target = mark?.closest<HTMLElement>("li, p, blockquote, td, h1, h2, h3, h4, h5, h6") ?? mark;
      target?.scrollIntoView({ block: "center" });
      target?.classList.add("block-flash");
      return;
    }
    const want = headingKey(jumpHeading);
    const h = [...box.current.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].find(
      (e) => !e.closest(".note-embed-body") && headingKey(e.textContent ?? "") === want,
    );
    h?.scrollIntoView({ block: "start" });
  }, [html, jumpSeq, path]);

  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.classList.contains("task")) {
      e.preventDefault();
      if (t.closest(".note-embed-body")) return; // another note's task: read-only here
      const all = [...box.current!.querySelectorAll("input.task")].filter((x) => !x.closest(".note-embed-body"));
      onToggleTask(all.indexOf(t));
      return;
    }
    const a = t.closest("a");
    if (!a) return;
    // Never let the app window navigate away.
    e.preventDefault();
    // Ctrl+click (or a middle click, see onAuxClick) opens a note link in a new tab.
    const opts = { newTab: e.ctrlKey || e.metaKey || e.button === 1 };
    const { followLink, searchTag } = useApp.getState();
    if (a.dataset.tag) searchTag(a.dataset.tag);
    else if (a.dataset.target !== undefined) void followLink(a.dataset.target, a.dataset.heading ?? null, opts);
    else if (a.dataset.dest) {
      const from = a.closest<HTMLElement>("[data-from]")?.dataset.from ?? path;
      const r = resolveDest(from, a.dataset.dest);
      if (r) void followLink(r, null, opts);
    } else {
      const url = a.dataset.url ?? a.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(url)) void openUrl(url).catch(() => {});
    }
  };

  return (
    <div
      ref={box}
      className="note-view"
      onClick={onClick}
      onMouseDown={(e) => e.button === 1 && (e.target as HTMLElement).closest("a") && e.preventDefault()}
      onAuxClick={(e) => e.button === 1 && !(e.target instanceof HTMLInputElement) && onClick(e)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
