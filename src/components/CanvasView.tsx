// 캔버스: .canvas 파일(JSON Canvas)을 편집기 자리에서 보고 고친다. 글 상자·노트 카드·묶음을
// 자유롭게 놓고 선으로 잇는다. 고친 내용은 잠시 뒤 자동 저장된다.
import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "../api";
import { useApp } from "../store";
import { safeHtml } from "../lib/safeHtml";
import { BackButton } from "./BackButton";
import { findNode, noteTitle } from "../lib/tree";
import { rankNotes } from "../lib/fuzzy";
import {
  CANVAS_COLORS,
  SIDES,
  addEdge,
  addNode,
  bounds,
  colorOf,
  dragSet,
  edgeEnds,
  edgePath,
  facingSide,
  fitView,
  freeSpot,
  hitNode,
  moveNodes,
  newId,
  parseCanvas,
  removeItems,
  resizeNode,
  serializeCanvas,
  updateNode,
  type Canvas,
  type CanvasNode,
  type Point,
  type Side,
} from "../lib/canvas";

import { tx } from "../i18n";
const DRAG_TYPE = "application/x-notevine-path";
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 3;

type View = { x: number; y: number; zoom: number };
type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "move"; sx: number; sy: number; ids: Set<string>; base: Canvas; moved: boolean }
  | { kind: "resize"; sx: number; sy: number; id: string; w: number; h: number; base: Canvas }
  | { kind: "connect"; from: string; side: Side };

export function CanvasView({ path }: { path: string }) {
  const notes = useApp((s) => s.notes);
  const tree = useApp((s) => s.tree);
  const savedSeq = useApp((s) => s.savedSeq);
  const { closeCanvas, toast, setFlushEditor, openSplit, openAttachment, followLink } = useApp.getState();
  const stage = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<Canvas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [link, setLink] = useState<{ from: string; side: Side; to: Point } | null>(null);
  const [picker, setPicker] = useState(false);
  const boardRef = useRef<Canvas | null>(null);
  const viewRef = useRef(view);
  const drag = useRef<Drag | null>(null);
  const past = useRef<Canvas[]>([]);
  const future = useRef<Canvas[]>([]);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  boardRef.current = board;
  viewRef.current = view;
  const name = path.split("/").pop()!.replace(/\.canvas$/i, "");

  async function save() {
    window.clearTimeout(timer.current);
    const b = boardRef.current;
    if (!dirty.current || !b) return;
    dirty.current = false;
    try {
      await api.saveCanvas(path, serializeCanvas(b));
    } catch (e) {
      dirty.current = true;
      toast(tx("캔버스를 저장하지 못했습니다: {0}", errorMessage(e)), "error");
    }
  }

  // Load, then show every card. Save what is left when the board closes.
  useEffect(() => {
    let live = true;
    api
      .readNote(path)
      .then((text) => {
        if (!live) return;
        const b = parseCanvas(text);
        setBoard(b);
        const r = stage.current?.getBoundingClientRect();
        if (r) setView(fitView(bounds(b.nodes), r.width, r.height));
      })
      .catch((e) => live && setError(errorMessage(e)));
    setFlushEditor(() => save());
    return () => {
      live = false;
      void save();
      setFlushEditor(async () => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  /** Changes the board; `record` keeps the previous state for Ctrl+Z. */
  function commit(next: Canvas, record = true, before = boardRef.current) {
    // No changes while the note folder switches: they could only be saved into the other folder (FR-VLT-07).
    if (!before || next === before || useApp.getState().switchLocked) return;
    if (record) {
      past.current = [...past.current.slice(-99), before];
      future.current = [];
    }
    boardRef.current = next;
    setBoard(next);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 400);
  }

  function undo(redo = false) {
    const from = redo ? future : past;
    const to = redo ? past : future;
    const prev = from.current.pop();
    const cur = boardRef.current;
    if (!prev || !cur) return;
    to.current.push(cur);
    commit(prev, false);
    setSelected(new Set());
    setSelEdge(null);
  }

  // Screen ↔ board coordinates.
  const toWorld = (clientX: number, clientY: number): Point => {
    const r = stage.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  };
  const center = (): Point => {
    const r = stage.current!.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  };

  function zoomAt(factor: number, clientX?: number, clientY?: number) {
    const r = stage.current!.getBoundingClientRect();
    const sx = (clientX ?? r.left + r.width / 2) - r.left;
    const sy = (clientY ?? r.top + r.height / 2) - r.top;
    setView((v) => {
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor));
      return { zoom, x: sx - ((sx - v.x) * zoom) / v.zoom, y: sy - ((sy - v.y) * zoom) / v.zoom };
    });
  }

  function fit() {
    const r = stage.current?.getBoundingClientRect();
    if (r && board) setView(fitView(bounds(board.nodes), r.width, r.height));
  }

  // Wheel: scroll the board; Ctrl+wheel zooms at the pointer. Not passive, to keep the page still.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".cv-scroll") && !e.ctrlKey) return;
      e.preventDefault();
      if (e.ctrlKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      else setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** Adds a card; `free` moves it off cards it would cover. */
  function place(node: CanvasNode, edit = false, free = false) {
    if (!board) return;
    if (free) node = { ...node, ...freeSpot(board.nodes.filter((n) => n.type !== "group"), node) } as CanvasNode;
    commit(addNode(board, node));
    setSelected(new Set([node.id]));
    setSelEdge(null);
    if (edit) setEditing(node.id);
  }

  /** A text card at `at` (where the user double-clicked), or in a free spot near the middle. */
  function addText(at?: Point) {
    const p = at ?? center();
    place({ id: newId(), type: "text", text: "", x: Math.round(p.x - 125), y: Math.round(p.y - 30), width: 250, height: 60 }, true, !at);
  }

  function addFile(file: string, at?: Point) {
    const image = IMAGE.test(file);
    const [w, h] = /\.md$/i.test(file) ? [320, 220] : image ? [300, 200] : [260, 60];
    const p = at ?? center();
    place({ id: newId(), type: "file", file, x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), width: w, height: h }, false, !at);
  }

  function addGroup() {
    if (!board) return;
    const picked = board.nodes.filter((n) => selected.has(n.id));
    const box = bounds(picked);
    const c = center();
    const g: CanvasNode = box
      ? { id: newId(), type: "group", label: tx("묶음"), x: box.x - 30, y: box.y - 50, width: box.width + 60, height: box.height + 80 }
      : { id: newId(), type: "group", label: tx("묶음"), x: Math.round(c.x - 200), y: Math.round(c.y - 150), width: 400, height: 300 };
    place(g, true);
  }

  function removeSelected() {
    if (!board || (!selected.size && !selEdge)) return;
    commit(removeItems(board, selected, new Set(selEdge ? [selEdge] : [])));
    setSelected(new Set());
    setSelEdge(null);
  }

  function setColor(color: string | undefined) {
    if (!board) return;
    let next = board;
    for (const id of selected) next = updateNode(next, id, { color });
    if (selEdge) next = { ...next, edges: next.edges.map((e) => (e.id === selEdge ? { ...e, color } : e)) };
    commit(next);
  }

  // ----- pointer: pan the background, move/resize cards, draw lines -----

  function onStageDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    stage.current?.focus();
    setEditing(null);
    if (!e.shiftKey) {
      setSelected(new Set());
      setSelEdge(null);
    }
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, view: viewRef.current };
    stage.current?.setPointerCapture(e.pointerId);
  }

  function onNodeDown(e: React.PointerEvent, n: CanvasNode) {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("textarea, input")) return;
    e.stopPropagation();
    // Keep the browser from selecting or dragging the card's text instead of moving the card.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    stage.current?.focus();
    const b = boardRef.current!;
    setSelEdge(null);
    if (t.classList.contains("cv-dot")) {
      drag.current = { kind: "connect", from: n.id, side: t.dataset.side as Side };
      setLink({ from: n.id, side: t.dataset.side as Side, to: toWorld(e.clientX, e.clientY) });
    } else if (t.classList.contains("cv-resize")) {
      drag.current = { kind: "resize", sx: e.clientX, sy: e.clientY, id: n.id, w: n.width, h: n.height, base: b };
    } else {
      let sel = selected;
      if (e.shiftKey) {
        sel = new Set(selected);
        if (sel.has(n.id)) sel.delete(n.id);
        else sel.add(n.id);
      } else if (!selected.has(n.id)) sel = new Set([n.id]);
      setSelected(sel);
      if (editing && editing !== n.id) setEditing(null);
      drag.current = { kind: "move", sx: e.clientX, sy: e.clientY, ids: dragSet(b, sel.has(n.id) ? sel : new Set([n.id])), base: b, moved: false };
    }
    stage.current?.setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const z = viewRef.current.zoom;
    if (d.kind === "pan") {
      setView({ ...d.view, x: d.view.x + e.clientX - d.sx, y: d.view.y + e.clientY - d.sy });
    } else if (d.kind === "move") {
      const dx = (e.clientX - d.sx) / z;
      const dy = (e.clientY - d.sy) / z;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
      d.moved = true;
      commit(moveNodes(d.base, d.ids, dx, dy), false);
    } else if (d.kind === "resize") {
      commit(resizeNode(d.base, d.id, d.w + (e.clientX - d.sx) / z, d.h + (e.clientY - d.sy) / z), false);
    } else {
      setLink({ from: d.from, side: d.side, to: toWorld(e.clientX, e.clientY) });
    }
  }

  function onUp(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // A move or resize is one step for Ctrl+Z, however many frames it took.
    if ((d.kind === "move" && d.moved) || d.kind === "resize") {
      const now = boardRef.current!;
      if (now !== d.base) {
        past.current = [...past.current.slice(-99), d.base];
        future.current = [];
      }
    } else if (d.kind === "connect") {
      setLink(null);
      const b = boardRef.current!;
      const at = toWorld(e.clientX, e.clientY);
      const target = hitNode(b.nodes, at);
      if (target && target.id !== d.from) commit(addEdge(b, d.from, d.side, target.id, facingSide(target, at)));
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).closest("textarea, input")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if (ctrl && key === "z") undo(e.shiftKey);
    else if (ctrl && key === "y") undo(true);
    else if (ctrl && key === "a" && board) setSelected(new Set(board.nodes.map((n) => n.id)));
    else if (e.key === "Escape") {
      if (!selected.size && !selEdge) return closeCanvas();
      setSelected(new Set());
      setSelEdge(null);
    } else if (e.key === "Enter" && selected.size === 1) setEditing([...selected][0]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // A note renamed or moved rewrites this board on disk (its cards follow): take that in,
  // unless there are changes here still to save.
  useEffect(() => {
    if (!savedSeq) return;
    let live = true;
    api
      .readNote(path)
      .then((text) => {
        const b = boardRef.current;
        if (!live || dirty.current || !b || text === serializeCanvas(b)) return;
        const next = parseCanvas(text);
        boardRef.current = next;
        setBoard(next);
      })
      .catch(() => {});
    return () => void (live = false);
  }, [savedSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- note cards: their text, read again after saves -----
  const files = useMemo(() => [...new Set(board?.nodes.flatMap((n) => (n.type === "file" && /\.md$/i.test(n.file) ? [n.file] : [])) ?? [])], [board]);
  const [texts, setTexts] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    Promise.all(files.map((f) => api.readNote(f).then((t): [string, string | null] => [f, t]).catch((): [string, null] => [f, null]))).then(
      (pairs) => live && setTexts(Object.fromEntries(pairs)),
    );
    return () => void (live = false);
  }, [files.join("\n"), savedSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  function onContentClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.url) void openUrl(a.dataset.url).catch(() => {});
    else if (a.dataset.target !== undefined) void followLink(a.dataset.target, a.dataset.heading || null);
    else if (a.dataset.dest) void followLink(decodeURIComponent(a.dataset.dest));
  }

  function openCard(n: CanvasNode) {
    if (n.type === "file") {
      if (/\.md$/i.test(n.file)) openSplit(n.file);
      else void openAttachment(n.file);
    } else if (n.type === "link") void openUrl(n.url).catch(() => {});
    else setEditing(n.id);
  }

  if (error) {
    return (
      <div className="canvas-view">
        <CanvasHead name={name} path={path} onClose={closeCanvas} />
        <p className="pad error-text">{tx("캔버스를 열지 못했습니다: {0}", error)}</p>
      </div>
    );
  }

  const byId = new Map(board?.nodes.map((n) => [n.id, n]) ?? []);
  const anySel = selected.size > 0 || !!selEdge;

  return (
    <div className="canvas-view">
      <CanvasHead name={name} path={path} onClose={closeCanvas}>
        <span className="cv-tools">
          <button className="btn ghost small" title={tx("빈 곳을 두 번 눌러도 됩니다")} onClick={() => addText()}>
            {tx("＋ 글 상자")}
          </button>
          <button className="btn ghost small" title={tx("파일 트리에서 노트를 끌어와도 됩니다")} onClick={() => setPicker(true)}>
            {tx("＋ 노트")}
          </button>
          <button className="btn ghost small" title={tx("고른 카드를 묶음으로 감쌉니다")} onClick={addGroup}>
            {tx("＋ 묶음")}
          </button>
        </span>
        {anySel && (
          <span className="cv-colors" aria-label={tx("색")}>
            <button className="cv-swatch none" title={tx("색 없음")} onClick={() => setColor(undefined)} />
            {CANVAS_COLORS.map(([c, label]) => (
              <button key={c} className="cv-swatch" title={label} style={{ background: colorOf(c) }} onClick={() => setColor(c)} />
            ))}
            <button className="icon-btn" title={tx("지우기 (Delete)")} onClick={removeSelected}>
              🗑
            </button>
          </span>
        )}
        <span className="pdf-zoom">
          <button className="icon-btn" title={tx("축소 (Ctrl+휠)")} onClick={() => zoomAt(1 / 1.2)}>
            −
          </button>
          <button className="btn ghost small" title={tx("모든 카드가 보이게")} onClick={fit}>
            {Math.round(view.zoom * 100)}%
          </button>
          <button className="icon-btn" title={tx("확대 (Ctrl+휠)")} onClick={() => zoomAt(1.2)}>
            ＋
          </button>
        </span>
      </CanvasHead>
      <div
        className="canvas-stage"
        ref={stage}
        tabIndex={0}
        onPointerDown={onStageDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        onDoubleClick={(e) => e.target === stage.current && addText(toWorld(e.clientX, e.clientY))}
        onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && e.preventDefault()}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (!from || !findNode(tree, from) || findNode(tree, from)?.kind === "folder") return;
          e.preventDefault();
          addFile(from, toWorld(e.clientX, e.clientY));
        }}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px` }}
      >
        {board && !board.nodes.length && <p className="cv-empty muted">{tx("빈 곳을 두 번 눌러 글 상자를 만들거나, 파일 트리에서 노트를 끌어다 놓으세요.")}</p>}
        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="cv-edges" width="1" height="1">
            <defs>
              <marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
              </marker>
            </defs>
            {board?.edges.map((ed) => {
              const a = byId.get(ed.fromNode);
              const b = byId.get(ed.toNode);
              if (!a || !b) return null;
              const ends = edgeEnds(a, b, ed);
              const d = edgePath(ends.a, ends.fromSide, ends.b, ends.toSide);
              const mid = { x: (ends.a.x + ends.b.x) / 2, y: (ends.a.y + ends.b.y) / 2 };
              return (
                <g key={ed.id} className={selEdge === ed.id ? "cv-edge on" : "cv-edge"} style={{ color: colorOf(ed.color) }}>
                  <path
                    className="cv-edge-hit"
                    d={d}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      stage.current?.focus();
                      setSelected(new Set());
                      setSelEdge(ed.id);
                    }}
                  />
                  <path
                    className="cv-edge-line"
                    d={d}
                    markerEnd={(ed.toEnd ?? "arrow") === "arrow" ? "url(#cv-arrow)" : undefined}
                    markerStart={ed.fromEnd === "arrow" ? "url(#cv-arrow)" : undefined}
                  />
                  {ed.label && (
                    <text x={mid.x} y={mid.y} className="cv-edge-label">
                      {ed.label}
                    </text>
                  )}
                </g>
              );
            })}
            {link &&
              (() => {
                const a = byId.get(link.from);
                if (!a) return null;
                const from = edgeEnds(a, { ...link.to, width: 0, height: 0 }, { fromSide: link.side }).a;
                return <path className="cv-edge-line drawing" d={edgePath(from, link.side, link.to)} markerEnd="url(#cv-arrow)" />;
              })()}
          </svg>
          {board?.nodes.map((n) => (
            <CardView
              key={n.id}
              node={n}
              selected={selected.has(n.id)}
              editing={editing === n.id}
              text={n.type === "file" ? texts[n.file] : undefined}
              exists={n.type !== "file" || !!findNode(tree, n.file)}
              title={n.type === "file" && /\.md$/i.test(n.file) ? (notes.find((x) => x.path === n.file)?.title ?? noteTitle(n.file)) : undefined}
              onDown={(e) => onNodeDown(e, n)}
              onOpen={() => openCard(n)}
              onContentClick={onContentClick}
              onEdit={(patch) => commit(updateNode(boardRef.current!, n.id, patch))}
              onDoneEditing={() => {
                setEditing(null);
                stage.current?.focus();
              }}
            />
          ))}
        </div>
      </div>
      {picker && (
        <NotePicker
          onPick={(p) => {
            setPicker(false);
            if (p) addFile(p);
          }}
        />
      )}
    </div>
  );
}

function CanvasHead({ name, path, onClose, children }: { name: string; path: string; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="pdf-head canvas-head">
      <BackButton onClick={onClose} />
      <span className="pdf-name" title={path}>
        {name}
      </span>
      {children}
      <button className="icon-btn" title={tx("캔버스 닫기")} onClick={onClose}>
        ×
      </button>
    </div>
  );
}

function CardView({
  node: n,
  selected,
  editing,
  text,
  exists,
  title,
  onDown,
  onOpen,
  onContentClick,
  onEdit,
  onDoneEditing,
}: {
  node: CanvasNode;
  selected: boolean;
  editing: boolean;
  text: string | null | undefined;
  exists: boolean;
  title: string | undefined;
  onDown: (e: React.PointerEvent) => void;
  onOpen: () => void;
  onContentClick: (e: React.MouseEvent) => void;
  onEdit: (patch: Partial<CanvasNode>) => void;
  onDoneEditing: () => void;
}) {
  const color = colorOf(n.color);
  const style: React.CSSProperties = { left: n.x, top: n.y, width: n.width, height: n.height, ...(color ? { ["--cv-color" as string]: color } : {}) };
  const html = useMemo(() => {
    if (n.type === "text") return safeHtml(n.text);
    if (n.type === "file" && text) return safeHtml(text.slice(0, 3000));
    return "";
  }, [n, text]);

  return (
    <div
      className={["cv-node", n.type, selected ? "on" : "", color ? "colored" : "", exists ? "" : "missing"].join(" ")}
      style={style}
      data-id={n.id}
      onPointerDown={onDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {n.type === "group" ? (
        editing ? (
          <input
            className="cv-group-input"
            autoFocus
            defaultValue={n.label ?? ""}
            onBlur={(e) => {
              if (e.target.value !== (n.label ?? "")) onEdit({ label: e.target.value });
              onDoneEditing();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
            }}
          />
        ) : (
          <span className="cv-group-label">{n.label || tx("묶음")}</span>
        )
      ) : n.type === "text" ? (
        editing ? (
          <textarea
            className="cv-textarea"
            autoFocus
            defaultValue={n.text}
            placeholder={tx("마크다운으로 쓰세요 · 다 쓰면 Esc")}
            onBlur={(e) => {
              if (e.target.value !== n.text) onEdit({ text: e.target.value });
              onDoneEditing();
            }}
            onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
          />
        ) : (
          <div className="cv-scroll note-view" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: html || tx("<p class=\"muted\">두 번 눌러 쓰기</p>") }} />
        )
      ) : n.type === "file" ? (
        <FileCard file={n.file} title={title} html={html} exists={exists} onContentClick={onContentClick} />
      ) : (
        <div className="cv-scroll cv-link" title={tx("두 번 눌러 브라우저로 열기")}>
          🔗 {n.url}
        </div>
      )}
      {SIDES.map((s) => (
        <span key={s} className={`cv-dot ${s}`} data-side={s} title={tx("끌어서 다른 카드와 잇기")} />
      ))}
      {selected && <span className="cv-resize" title={tx("끌어서 크기 바꾸기")} />}
    </div>
  );
}

function FileCard({ file, title, html, exists, onContentClick }: { file: string; title?: string; html: string; exists: boolean; onContentClick: (e: React.MouseEvent) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const image = IMAGE.test(file);
  useEffect(() => {
    if (!image || !exists) return;
    let live = true;
    api
      .attachmentPath(file)
      .then((abs) => live && setSrc(convertFileSrc(abs)))
      .catch(() => {});
    return () => void (live = false);
  }, [file, image, exists]);

  const name = file.split("/").pop()!;
  if (!exists) return <div className="cv-file-title">{tx("⚠ 없음: {0}", file)}</div>;
  if (image) return src ? <img className="cv-image" src={src} alt={name} draggable={false} /> : <div className="cv-file-title">{name}</div>;
  if (title === undefined) return <div className="cv-file-title" title={tx("두 번 눌러 열기")}>📄 {name}</div>;
  return (
    <>
      <div className="cv-file-title" title={tx("{0}\n두 번 누르면 오른쪽에 열립니다", file)}>
        {title}
      </div>
      <div className="cv-scroll note-view" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

/** Picks a note to put on the board. */
function NotePicker({ onPick }: { onPick: (path: string | null) => void }) {
  const notes = useApp((s) => s.notes);
  const recent = useApp((s) => s.recent);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const items = useMemo(() => rankNotes(notes, q, recent).slice(0, 50), [notes, q, recent]);
  return (
    <div className="modal-backdrop top" onMouseDown={() => onPick(null)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder={tx("캔버스에 놓을 노트 이름")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") onPick(null);
            else if (e.key === "ArrowDown") setSel((i) => Math.min(i + 1, items.length - 1));
            else if (e.key === "ArrowUp") setSel((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && items[sel]) onPick(items[sel].path);
            else return;
            e.preventDefault();
          }}
        />
        <ul className="palette-list">
          {items.map((n, i) => (
            <li key={n.path} className={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => onPick(n.path)}>
              <span>{n.title}</span>
              <span className="muted small">{n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : ""}</span>
            </li>
          ))}
          {!items.length && <li className="muted">{tx("찾는 노트가 없습니다")}</li>}
        </ul>
      </div>
    </div>
  );
}
