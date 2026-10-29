// SCR-04 읽기 모드: 서식이 적용된 노트. 링크·태그·체크박스는 눌러서 쓸 수 있다.
import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { useApp } from "../store";
import { noteToHtml } from "../lib/renderNote";
import { noteExists, resolveDest } from "../editor/wikilinks";
import { safeStyle } from "../editor/colors";

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

export function NoteView({ path, text, onToggleTask }: { path: string; text: string; onToggleTask: (index: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const html = useMemo(() => safeHtml(text), [text]);
  const notes = useApp((s) => s.notes);

  // Mark links to notes that don't exist yet; fill in local images.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.querySelectorAll<HTMLAnchorElement>("a.wikilink[data-target]").forEach((a) => {
      const t = a.dataset.target!;
      const file = /\.[a-z0-9]{1,8}$/i.test(t) && !/\.md$/i.test(t);
      a.classList.toggle("unresolved", !file && !noteExists(notes, t));
    });
    let live = true;
    el.querySelectorAll<HTMLImageElement>("img[data-embed]").forEach((img) => {
      const target = img.dataset.embed!;
      const rel = img.dataset.md ? Promise.resolve(resolveDest(path, target)) : api.resolveAttachment(target, path);
      rel
        .then(async (r) => (r ? convertFileSrc(await api.attachmentPath(r)) : null))
        .catch(() => null)
        .then((url) => {
          if (!live) return;
          if (url) img.src = url;
          else img.replaceWith(Object.assign(document.createElement("span"), { className: "missing", textContent: `첨부 없음: ${target}` }));
        });
    });
    return () => {
      live = false;
    };
  }, [html, notes, path]);

  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.classList.contains("task")) {
      e.preventDefault();
      const all = [...box.current!.querySelectorAll("input.task")];
      onToggleTask(all.indexOf(t));
      return;
    }
    const a = t.closest("a");
    if (!a) return;
    // Never let the app window navigate away.
    e.preventDefault();
    const { followLink } = useApp.getState();
    if (a.dataset.target) void followLink(a.dataset.target);
    else if (a.dataset.dest) {
      const r = resolveDest(path, a.dataset.dest);
      if (r) void followLink(r);
    } else {
      const url = a.dataset.url ?? a.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(url)) void openUrl(url).catch(() => {});
    }
  };

  return <div ref={box} className="note-view" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
