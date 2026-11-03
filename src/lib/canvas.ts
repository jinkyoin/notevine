// 캔버스(.canvas) 데이터: JSON Canvas 형식(https://jsoncanvas.org)의 카드와 연결선.
// 화면과 상관없는 계산만 여기에 두고, 그리기와 마우스 조작은 CanvasView가 맡는다.
import { tx } from "../i18n";

export type Side = "top" | "right" | "bottom" | "left";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** "1"~"6" (빨강·주황·노랑·초록·청록·보라) or "#rrggbb". */
  color?: string;
}

export type CanvasNode =
  | (NodeBase & { type: "text"; text: string })
  | (NodeBase & { type: "file"; file: string; subpath?: string })
  | (NodeBase & { type: "link"; url: string })
  | (NodeBase & { type: "group"; label?: string });

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: "none" | "arrow";
  toNode: string;
  toSide?: Side;
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_SIZE = { width: 80, height: 40 };
export const SIDES: Side[] = ["top", "right", "bottom", "left"];

/** Reads a board; missing lists are empty and entries without an id or a known type are left out. */
export function parseCanvas(text: string): Canvas {
  const raw = text.trim() ? JSON.parse(text) : {};
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .filter((n: any) => n && typeof n.id === "string" && ["text", "file", "link", "group"].includes(n.type))
    .map((n: any) => ({
      ...n,
      x: num(n.x, 0),
      y: num(n.y, 0),
      width: Math.max(MIN_SIZE.width, num(n.width, 250)),
      height: Math.max(MIN_SIZE.height, num(n.height, 60)),
      ...(n.type === "text" ? { text: typeof n.text === "string" ? n.text : "" } : {}),
    })) as CanvasNode[];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).filter(
    (e: any) => e && typeof e.id === "string" && ids.has(e.fromNode) && ids.has(e.toNode),
  ) as CanvasEdge[];
  return { ...raw, nodes, edges };
}

export function serializeCanvas(c: Canvas): string {
  return JSON.stringify(c, null, 2) + "\n";
}

export function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function addNode(c: Canvas, node: CanvasNode): Canvas {
  // Groups go first so they are drawn under the cards placed on them.
  return { ...c, nodes: node.type === "group" ? [node, ...c.nodes] : [...c.nodes, node] };
}

export function updateNode(c: Canvas, id: string, patch: Partial<CanvasNode>): Canvas {
  return { ...c, nodes: c.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)) };
}

export function moveNodes(c: Canvas, ids: Set<string>, dx: number, dy: number): Canvas {
  if (!dx && !dy) return c;
  return { ...c, nodes: c.nodes.map((n) => (ids.has(n.id) ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)) };
}

export function resizeNode(c: Canvas, id: string, width: number, height: number): Canvas {
  return updateNode(c, id, {
    width: Math.round(Math.max(MIN_SIZE.width, width)),
    height: Math.round(Math.max(MIN_SIZE.height, height)),
  });
}

/** Removes cards and lines; lines to a removed card go with it. */
export function removeItems(c: Canvas, nodeIds: Set<string>, edgeIds: Set<string> = new Set()): Canvas {
  return {
    ...c,
    nodes: c.nodes.filter((n) => !nodeIds.has(n.id)),
    edges: c.edges.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode)),
  };
}

/** Joins two cards with an arrow; refuses a card to itself and a second line between the same sides. */
export function addEdge(c: Canvas, fromNode: string, fromSide: Side, toNode: string, toSide: Side): Canvas {
  if (fromNode === toNode) return c;
  const dup = c.edges.some(
    (e) =>
      (e.fromNode === fromNode && e.toNode === toNode && e.fromSide === fromSide && e.toSide === toSide) ||
      (e.fromNode === toNode && e.toNode === fromNode && e.fromSide === toSide && e.toSide === fromSide),
  );
  if (dup) return c;
  return { ...c, edges: [...c.edges, { id: newId(), fromNode, fromSide, toNode, toSide, toEnd: "arrow" }] };
}

/** The middle of a card's side, where lines attach. */
export function anchor(r: Rect, side: Side): Point {
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2, y: r.y };
    case "bottom":
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height / 2 };
    case "right":
      return { x: r.x + r.width, y: r.y + r.height / 2 };
  }
}

/** The side of `r` that faces `p`. */
export function facingSide(r: Rect, p: Point): Side {
  const dx = (p.x - (r.x + r.width / 2)) / (r.width / 2);
  const dy = (p.y - (r.y + r.height / 2)) / (r.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

const NORMAL: Record<Side, Point> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** SVG path of a curved line leaving `a` from `aSide` and entering at `b` (from `bSide`, or straight when unknown). */
export function edgePath(a: Point, aSide: Side, b: Point, bSide?: Side): string {
  const pull = Math.max(40, Math.hypot(b.x - a.x, b.y - a.y) / 3);
  const c1 = { x: a.x + NORMAL[aSide].x * pull, y: a.y + NORMAL[aSide].y * pull };
  const c2 = bSide ? { x: b.x + NORMAL[bSide].x * pull, y: b.y + NORMAL[bSide].y * pull } : b;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M${r(a.x)},${r(a.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(b.x)},${r(b.y)}`;
}

/** Ends of a line: the sides it names, else the sides the two cards face each other with. */
export function edgeEnds(from: Rect, to: Rect, e: Pick<CanvasEdge, "fromSide" | "toSide">) {
  const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const fromSide = e.fromSide ?? facingSide(from, center(to));
  const toSide = e.toSide ?? facingSide(to, center(from));
  return { fromSide, toSide, a: anchor(from, fromSide), b: anchor(to, toSide) };
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

export function hitNode(nodes: CanvasNode[], p: Point): CanvasNode | null {
  // Topmost first: later cards are drawn over earlier ones, groups under everything.
  const inside = (n: CanvasNode) => p.x >= n.x && p.y >= n.y && p.x <= n.x + n.width && p.y <= n.y + n.height;
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].type !== "group" && inside(nodes[i])) return nodes[i];
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].type === "group" && inside(nodes[i])) return nodes[i];
  return null;
}

/** Cards a drag of `ids` moves: the cards themselves and whatever lies inside a dragged group. */
export function dragSet(c: Canvas, ids: Set<string>): Set<string> {
  const out = new Set(ids);
  for (const g of c.nodes) {
    if (g.type !== "group" || !ids.has(g.id)) continue;
    for (const n of c.nodes) if (n.id !== g.id && contains(g, n)) out.add(n.id);
  }
  return out;
}

/** `r` moved right (then down) until it overlaps no card, so a new card never lands on another. */
export function freeSpot(nodes: Rect[], r: Rect, gap = 40): Rect {
  const hits = (x: number, y: number) =>
    nodes.some((n) => x < n.x + n.width + gap / 2 && x + r.width + gap / 2 > n.x && y < n.y + n.height + gap / 2 && y + r.height + gap / 2 > n.y);
  for (let row = 0; row < 10; row++) {
    const y = r.y + row * (r.height + gap);
    let x = r.x;
    for (let i = 0; i < 20 && hits(x, y); i++) {
      const blocker = nodes.filter((n) => x < n.x + n.width + gap / 2 && x + r.width + gap / 2 > n.x && y < n.y + n.height + gap / 2 && y + r.height + gap / 2 > n.y);
      x = Math.max(...blocker.map((n) => n.x + n.width)) + gap;
    }
    if (!hits(x, y)) return { ...r, x, y };
  }
  return r;
}

/** The box around every card, or null for an empty board. */
export function bounds(nodes: Rect[]): Rect | null {
  if (!nodes.length) return null;
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  const right = Math.max(...nodes.map((n) => n.x + n.width));
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Zoom and offset that show `box` in a `w`×`h` view with a margin, never above 100%. */
export function fitView(box: Rect | null, w: number, h: number): { zoom: number; x: number; y: number } {
  if (!box) return { zoom: 1, x: w / 2, y: h / 2 };
  const pad = 60;
  const zoom = Math.min(1, Math.max(0.1, Math.min((w - pad * 2) / box.width, (h - pad * 2) / box.height)));
  return { zoom, x: w / 2 - (box.x + box.width / 2) * zoom, y: h / 2 - (box.y + box.height / 2) * zoom };
}

export const CANVAS_COLORS: [string, string][] = [
  ["1", tx("빨강")],
  ["2", tx("주황")],
  ["3", tx("노랑")],
  ["4", tx("초록")],
  ["5", tx("청록")],
  ["6", tx("보라")],
];

const PRESET: Record<string, string> = { "1": "#e5484d", "2": "#f76b15", "3": "#e2b203", "4": "#30a46c", "5": "#12a594", "6": "#8e4ec6" };

export function colorOf(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return PRESET[color] ?? (/^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined);
}
