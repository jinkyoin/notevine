// 그래프 뷰 (FR-UI-05): 폴더 안 노트를 점으로, 노트 사이 링크를 선으로 그린다. 끌어서 이동, 휠로 확대, 누르면 노트가 열린다.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type LinkGraph } from "../api";
import { useApp } from "../store";
import { degrees, fitView, initialLayout, stepLayout, type Point } from "../lib/graphLayout";

import { tx } from "../i18n";
const TICKS = 300;

type Drag = { kind: "pan"; x: number; y: number; moved: boolean } | { kind: "node"; i: number; moved: boolean };

export function FolderGraph({ folder }: { folder: string }) {
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  // Changes when indexing a newly opened folder finishes.
  const indexed = useApp((s) => s.notes);
  const openPath = useApp((s) => s.openPath);
  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideLonely, setHideLonely] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [, redraw] = useState(0);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const pts = useRef<Point[]>([]);
  const lastPaths = useRef<string[]>([]);
  const drag = useRef<Drag | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const fit = () => setView(fitView(pts.current, sizeRef.current.w, sizeRef.current.h));

  useEffect(() => {
    let live = true;
    api
      .linkGraph(folder)
      .then((g) => live && (setGraph(g), setError(null)))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [folder, savedSeq, externalSeq, indexed]);

  // Notes and links shown: all, or only the linked ones.
  const shown = useMemo(() => {
    if (!graph) return null;
    const deg = degrees(graph.nodes.length, graph.edges);
    const keep = graph.nodes.map((_, i) => !hideLonely || deg[i] > 0);
    const index = new Map<number, number>();
    const nodes: (LinkGraph["nodes"][number] & { deg: number })[] = [];
    graph.nodes.forEach((n, i) => {
      if (!keep[i]) return;
      index.set(i, nodes.length);
      nodes.push({ ...n, deg: deg[i] });
    });
    const edges = graph.edges.filter(([a, b]) => keep[a] && keep[b]).map(([a, b]): [number, number] => [index.get(a)!, index.get(b)!]);
    return { nodes, edges };
  }, [graph, hideLonely]);

  // Lay out again from scratch when the graph changes, a few steps per frame.
  useEffect(() => {
    if (!shown) return;
    const prev = new Map(pts.current.map((p, i) => [lastPaths.current[i], p]));
    const start = initialLayout(shown.nodes.length);
    // Keep where known notes were, so a save doesn't reshuffle the picture.
    pts.current = shown.nodes.map((n, i) => prev.get(n.path) ?? start[i]);
    lastPaths.current = shown.nodes.map((n) => n.path);
    const known = prev.size > 0 && shown.nodes.every((n) => prev.has(n.path));
    let tick = known ? TICKS - 40 : 0;
    let frame = 0;
    const perFrame = shown.nodes.length > 600 ? 1 : 3;
    const run = () => {
      for (let s = 0; s < perFrame && tick < TICKS; s++, tick++) {
        if (stepLayout(pts.current, shown.edges, 1 - tick / TICKS) < 0.05 * shown.nodes.length) tick = TICKS;
      }
      redraw((n) => n + 1);
      if (tick < TICKS) frame = requestAnimationFrame(run);
      // A new picture is framed once it settles; one that only changed a little stays put.
      else if (!known) fit();
    };
    frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  // Wheel zoom around the pointer; React's onWheel is passive, so listen directly.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width / 2;
      const my = e.clientY - r.top - r.height / 2;
      setView((v) => {
        const k = Math.min(4, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }));
    ro.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, [shown]);

  if (error) return <p className="error pad">{tx("그래프를 만들지 못했습니다: {0}", error)}</p>;
  if (!shown) return null;

  const { nodes, edges } = shown;
  const near = new Set<number>();
  if (hover !== null) for (const [a, b] of edges) if (a === hover || b === hover) near.add(a === hover ? b : a);
  const radius = (deg: number) => 4 + Math.min(10, Math.sqrt(deg) * 2.2);
  const toGraph = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - view.x) / view.k, y: (e.clientY - r.top - r.height / 2 - view.y) / view.k };
  };

  return (
    <div className="graph">
      <div className="board-bar">
        <span className="muted small">
          {tx("노트 {0}개 · 링크 {1}개", nodes.length, edges.length)}
        </span>
        <label className="muted small">
          <input type="checkbox" checked={hideLonely} onChange={(e) => setHideLonely(e.target.checked)} /> {" "}{tx("링크 없는 노트 숨기기")}
        </label>
        <span className="spacer" />
        <button className="btn ghost small" onClick={fit}>
          {tx("화면에 맞추기")}
        </button>
      </div>
      {!nodes.length ? (
        <p className="muted pad">{tx("보여 줄 노트가 없습니다.")}</p>
      ) : (
        <svg
          ref={svg}
          className="graph-canvas"
          viewBox={`0 0 ${size.w} ${size.h}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            (e.target as Element).setPointerCapture?.(e.pointerId);
            const i = Number((e.target as Element).getAttribute("data-i") ?? NaN);
            drag.current = Number.isNaN(i) ? { kind: "pan", x: e.clientX - view.x, y: e.clientY - view.y, moved: false } : { kind: "node", i, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            d.moved = true;
            if (d.kind === "pan") setView((v) => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y }));
            else {
              const p = pts.current[d.i];
              Object.assign(p, toGraph(e), { vx: 0, vy: 0 });
              redraw((n) => n + 1);
            }
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (d?.kind === "node" && !d.moved) {
              useApp.getState().openNote(nodes[d.i].path, undefined, undefined, { newTab: e.ctrlKey || e.metaKey });
            }
          }}
        >
          <g transform={`translate(${size.w / 2 + view.x} ${size.h / 2 + view.y}) scale(${view.k})`}>
            <g className="graph-edges">
              {edges.map(([a, b]) => {
                const p = pts.current[a];
                const q = pts.current[b];
                if (!p || !q) return null;
                return <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={hover !== null && (a === hover || b === hover) ? "on" : ""} />;
              })}
            </g>
            {nodes.map((n, i) => {
              const p = pts.current[i];
              if (!p) return null;
              const r = radius(n.deg);
              const lit = hover === i || near.has(i);
              const dim = hover !== null && !lit;
              const label = nodes.length <= 60 || lit || n.path === openPath || view.k >= 1.4 || (n.deg >= 3 && view.k >= 0.8);
              return (
                <g
                  key={n.path}
                  className={`graph-node${n.path === openPath ? " current" : ""}${dim ? " dim" : ""}${lit ? " lit" : ""}`}
                  transform={`translate(${p.x} ${p.y})`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                >
                  <circle r={r} data-i={i}>
                    <title>{n.path}</title>
                  </circle>
                  {label && (
                    <text y={r + 11} fontSize={11 / Math.max(view.k, 0.6)}>
                      {n.title}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
