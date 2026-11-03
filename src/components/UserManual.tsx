// 사용자 매뉴얼 (Shift+F1, 도움말·설정 > 정보): docs/사용자매뉴얼.md를 읽기 모드처럼 보여 준다.
// 왼쪽 목차와 본문 안의 목차 링크는 그 제목으로 옮겨 간다.
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import { headingSlug, MANUAL, manualChapters } from "../lib/manual";
import { drawRichBlocks } from "../lib/richBlocks";
import { safeHtml } from "./NoteView";

import { tx } from "../i18n";
export function UserManual() {
  const modal = useApp((s) => s.modal);
  if (modal !== "manual") return null;
  return <ManualDialog close={() => useApp.getState().setModal(null)} />;
}

function ManualDialog({ close }: { close: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const html = useMemo(() => safeHtml(MANUAL), []);
  const chapters = useMemo(() => manualChapters(), []);
  const [current, setCurrent] = useState(chapters[0]?.slug ?? "");

  useEffect(() => {
    const root = body.current;
    if (!root) return;
    // Headings get the ids the manual's own links point to.
    for (const h of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4")) h.id = headingSlug(h.textContent ?? "");
    let live = true;
    void drawRichBlocks(root, () => live);
    return () => {
      live = false;
    };
  }, [html]);

  const go = (slug: string) => {
    const el = body.current?.querySelector<HTMLElement>(`[id="${CSS.escape(slug)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    setCurrent(chapters.find((c) => c.slug === slug) ? slug : current);
  };

  // The chapter being read follows the scroll.
  const onScroll = () => {
    const root = body.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top + 8;
    let at = chapters[0]?.slug ?? "";
    for (const c of chapters) {
      const el = root.querySelector<HTMLElement>(`[id="${CSS.escape(c.slug)}"]`);
      if (el && el.getBoundingClientRect().top <= top) at = c.slug;
    }
    setCurrent(at);
  };

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="modal manual" tabIndex={-1} ref={(el) => el?.focus()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="vv-head">
          <h2>{tx("사용자 매뉴얼")}</h2>
          <button className="icon-btn" title={tx("닫기 (Esc)")} onClick={close}>
            ×
          </button>
        </div>
        <div className="manual-main">
          <nav className="manual-toc" aria-label={tx("목차")}>
            {chapters.map((c) => (
              <button key={c.slug} className={c.slug === current ? "on" : ""} onClick={() => go(c.slug)}>
                {c.title}
              </button>
            ))}
          </nav>
          <div
            className="note-view manual-body"
            ref={body}
            onScroll={onScroll}
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest<HTMLElement>("a");
              if (!a) return;
              e.preventDefault();
              const dest = a.dataset.dest ?? "";
              if (dest.startsWith("#")) go(decodeURIComponent(dest.slice(1)));
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  );
}
