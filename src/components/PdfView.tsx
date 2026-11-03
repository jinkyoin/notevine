// PDF 보기·주석 (FR-ATT-03): 첨부 PDF를 편집기 자리에서 보고, 글을 골라 "이름 주석.md"에 주석을 단다.
// PDF 파일은 바꾸지 않는다. 주석을 단 글은 PDF 위에 형광펜으로 보인다.
import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath as openWithOs } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "../api";
import { useApp } from "../store";
import { findNode } from "../lib/tree";
import { annotationPath, parseAnnotations, quoteSpans, type Annotation } from "../lib/pdfNotes";

import { tx } from "../i18n";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function PdfView({ path, page, seq }: { path: string; page: number; seq: number }) {
  const tree = useApp((s) => s.tree);
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  const { closePdf, openNote, toast } = useApp.getState();
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(page);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [pick, setPick] = useState<{ page: number; quote: string; x: number; y: number } | null>(null);
  const [form, setForm] = useState<{ page: number; quote: string } | null>(null);
  const [memo, setMemo] = useState("");
  const notePath = annotationPath(path);
  const hasNote = !!findNode(tree, notePath);
  const scale = fit * zoom;
  const name = path.split("/").pop()!;

  // Open the file.
  useEffect(() => {
    let live = true;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    (async () => {
      const abs = await api.attachmentPath(path);
      const task = pdfjs.getDocument({
        url: convertFileSrc(abs),
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        isEvalSupported: false,
      });
      loaded = await task.promise;
      if (!live) return void loaded.destroy();
      const out: { w: number; h: number }[] = [];
      for (let i = 1; i <= loaded.numPages; i++) {
        const v = (await loaded.getPage(i)).getViewport({ scale: 1 });
        out.push({ w: v.width, h: v.height });
      }
      if (!live) return;
      setSizes(out);
      setDoc(loaded);
    })().catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
      void loaded?.destroy();
    };
  }, [path]);

  // Fit the widest page to the width of the view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !sizes.length) return;
    const widest = Math.max(...sizes.map((s) => s.w));
    const update = () => setFit(Math.max(0.2, (el.clientWidth - 48) / widest));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sizes]);

  // Annotations come from the note, read again whenever notes are saved.
  useEffect(() => {
    if (!hasNote) return setNotes([]);
    void api
      .readNote(notePath)
      .then((t) => setNotes(parseAnnotations(t).filter((a) => a.page >= 1)))
      .catch(() => setNotes([]));
  }, [notePath, hasNote, savedSeq, externalSeq]);

  const goTo = (n: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el) scroller.current!.scrollTop = el.offsetTop - 12;
  };

  // Jump to the page asked for once the pages have their size.
  useEffect(() => {
    if (doc && fit) requestAnimationFrame(() => goTo(page));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, seq]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    let at = 1;
    for (const p of el.querySelectorAll<HTMLElement>("[data-page]")) if (p.offsetTop <= mid) at = Number(p.dataset.page);
    // [주석 달기] sits in the scrolled content, so it stays by the text while scrolling.
    setCurrent(at);
  };

  // Text chosen on one page offers [주석 달기] next to it.
  const onMouseUp = () => {
    const sel = window.getSelection();
    const quote = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    const host = sel?.anchorNode?.parentElement?.closest<HTMLElement>("[data-page]");
    if (!sel || !quote || !host || !scroller.current) return setPick(null);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const box = scroller.current.getBoundingClientRect();
    setPick({ page: Number(host.dataset.page), quote, x: r.right - box.left, y: r.bottom - box.top + scroller.current.scrollTop + 4 });
  };

  const save = async () => {
    if (!form) return;
    const ok = await useApp.getState().annotatePdf(path, form.page, form.quote, memo);
    if (ok) {
      toast(tx("주석을 \"{0}\"에 넣었습니다", notePath.split("/").pop()));
      setForm(null);
      setMemo("");
      window.getSelection()?.removeAllRanges();
    }
  };

  const zoomBy = (d: number) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 1e-6);
    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 4 : i) + d))]);
  };

  const byPage = useMemo(() => {
    const m = new Map<number, Annotation[]>();
    for (const a of notes) m.set(a.page, [...(m.get(a.page) ?? []), a]);
    return m;
  }, [notes]);

  return (
    <div className="pdf-view" onKeyDown={(e) => e.key === "Escape" && !form && closePdf()} tabIndex={-1}>
      <div className="pdf-head">
        <span className="pdf-name" title={path}>
          {name}
        </span>
        <span className="pdf-pages">
          <button className="icon-btn" title={tx("이전 쪽")} disabled={current <= 1} onClick={() => goTo(current - 1)}>
            ‹
          </button>
          <input
            key={current}
            className="pdf-page-input"
            defaultValue={current}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const n = Number((e.target as HTMLInputElement).value);
              if (n >= 1 && n <= sizes.length) goTo(n);
            }}
          />
          <span className="muted">/ {sizes.length || "…"}</span>
          <button className="icon-btn" title={tx("다음 쪽")} disabled={current >= sizes.length} onClick={() => goTo(current + 1)}>
            ›
          </button>
        </span>
        <span className="pdf-zoom">
          <button className="icon-btn" title={tx("축소")} onClick={() => zoomBy(-1)}>
            −
          </button>
          <button className="btn ghost small" title={tx("폭에 맞추기")} onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn" title={tx("확대")} onClick={() => zoomBy(1)}>
            ＋
          </button>
        </span>
        <span className="pdf-actions">
          <button className="btn ghost small" disabled={!hasNote} onClick={() => openNote(notePath)} title={notePath}>
            {tx("주석 노트")}
          </button>
          <button
            className="btn ghost small"
            onClick={() => void api.attachmentPath(path).then(openWithOs).catch((e) => toast(errorMessage(e), "error"))}
          >
            {tx("기본 프로그램으로 열기")}
          </button>
          <button className="icon-btn" title={tx("닫기 (Esc)")} onClick={closePdf}>
            ×
          </button>
        </span>
      </div>
      <div className="pdf-main">
        <div className="pdf-scroll" ref={scroller} onScroll={onScroll} onMouseUp={onMouseUp}>
          {error && <p className="error pad">{tx("PDF를 열지 못했습니다: {0}", error)}</p>}
          {!doc && !error && <p className="muted pad">{tx("PDF를 여는 중…")}</p>}
          {doc &&
            sizes.map((s, i) => (
              <PdfPage key={i} doc={doc} n={i + 1} w={s.w * scale} h={s.h * scale} scale={scale} marks={byPage.get(i + 1) ?? []} />
            ))}
          {pick && !form && (
            <button
              className="btn primary small pdf-pick"
              style={{ left: pick.x, top: pick.y }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setForm({ page: pick.page, quote: pick.quote });
                setPick(null);
              }}
            >
              {tx("주석 달기")}
            </button>
          )}
        </div>
        <aside className="pdf-side">
          {form ? (
            <div className="pdf-form">
              <div className="small muted">{tx("p.{0}에 주석", form.page)}</div>
              <blockquote>{form.quote.length > 300 ? form.quote.slice(0, 300) + "…" : form.quote}</blockquote>
              <textarea
                autoFocus
                rows={4}
                placeholder={tx("메모 (비워도 됩니다)")}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
                  if (e.key === "Escape") setForm(null);
                }}
              />
              <div className="modal-actions">
                <button className="btn ghost small" onClick={() => setForm(null)}>
                  {tx("취소")}
                </button>
                <button className="btn primary small" onClick={() => void save()} title="Ctrl+Enter">
                  {tx("주석 저장")}
                </button>
              </div>
            </div>
          ) : (
            <p className="muted small">{tx("글을 끌어 고르면 [주석 달기]가 나옵니다. 주석은 \"{0}\"에 쌓입니다.", notePath.split("/").pop())}</p>
          )}
          <div className="pdf-notes">
            {notes.map((a, i) => (
              <button key={i} className="pdf-note" onClick={() => goTo(a.page)}>
                <span className="pdf-note-page">p.{a.page}</span>
                <span className="pdf-note-quote">{a.quote}</span>
                {a.memo && <span className="pdf-note-memo">{a.memo}</span>}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** One page: drawn when it comes near the view, with selectable text and highlights. */
function PdfPage({ doc, n, w, h, scale, marks }: { doc: PDFDocumentProxy; n: number; w: number; h: number; scale: number; marks: Annotation[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!near || !el) return;
    let live = true;
    let cancel = () => {};
    (async () => {
      const page = await doc.getPage(n);
      if (!live) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const render = page.render({
        canvasContext: canvas.getContext("2d")!,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      cancel = () => render.cancel();
      await render.promise;
      if (!live) return;
      const text = document.createElement("div");
      text.className = "textLayer";
      const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      await layer.render();
      if (!live) return;
      el.replaceChildren(canvas, text);
      setDrawn((d) => d + 1);
    })().catch(() => {});
    return () => {
      live = false;
      cancel();
    };
  }, [near, doc, n, scale]);

  // Highlight the annotated text.
  useEffect(() => {
    const spans = [...(box.current?.querySelectorAll<HTMLElement>(".textLayer span") ?? [])].filter((s) => !s.children.length);
    for (const s of spans) s.classList.remove("pdf-hl");
    for (const a of marks) for (const i of quoteSpans(spans.map((s) => s.textContent ?? ""), a.quote)) spans[i].classList.add("pdf-hl");
  }, [marks, drawn]);

  return (
    <div
      className="pdf-page"
      data-page={n}
      ref={box}
      style={{ width: w, height: h, "--scale-factor": scale, "--total-scale-factor": scale } as React.CSSProperties}
    />
  );
}
