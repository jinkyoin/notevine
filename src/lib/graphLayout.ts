// 그래프 뷰 (FR-UI-05)의 배치: 링크는 당기고 노트끼리는 밀어내는 단순한 힘 배치.

export interface Point {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Starting positions on a spiral, so the same graph always starts the same way. */
export function initialLayout(n: number): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const r = 30 * Math.sqrt(i + 0.5);
    const a = i * 2.39996; // golden angle
    return { x: r * Math.cos(a), y: r * Math.sin(a), vx: 0, vy: 0 };
  });
}

const LINK = 70; // rest length of a link
const REPEL = 1200;
const CENTER = 0.03;

/**
 * Moves the points one step; `heat` (1 → 0) scales the moves so the layout settles.
 * Returns how far the points moved in total.
 */
export function stepLayout(pts: Point[], edges: [number, number][], heat: number): number {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    for (let j = i + 1; j < n; j++) {
      const b = pts[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (i - j) * 0.1;
        dy = 0.1;
        d2 = dx * dx + dy * dy;
      }
      if (d2 > 250000) continue; // far apart: no push
      const f = REPEL / d2;
      a.vx += dx * f * 0.5;
      a.vy += dy * f * 0.5;
      b.vx -= dx * f * 0.5;
      b.vy -= dy * f * 0.5;
    }
  }
  for (const [i, j] of edges) {
    const a = pts[i];
    const b = pts[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = ((d - LINK) / d) * 0.1;
    a.vx += dx * f;
    a.vy += dy * f;
    b.vx -= dx * f;
    b.vy -= dy * f;
  }
  let moved = 0;
  for (const p of pts) {
    p.vx -= p.x * CENTER;
    p.vy -= p.y * CENTER;
    const vx = Math.max(-30, Math.min(30, p.vx * heat));
    const vy = Math.max(-30, Math.min(30, p.vy * heat));
    p.x += vx;
    p.y += vy;
    moved += Math.abs(vx) + Math.abs(vy);
    p.vx *= 0.5;
    p.vy *= 0.5;
  }
  return moved;
}

/** Zoom and offset that fit all points in a w×h box, zooming in at most to `max`. */
export function fitView(pts: { x: number; y: number }[], w: number, h: number, max = 1.2): { x: number; y: number; k: number } {
  if (!pts.length) return { x: 0, y: 0, k: 1 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Room for labels under the dots.
  const k = Math.min(max, (w - 120) / Math.max(x1 - x0, 1), (h - 80) / Math.max(y1 - y0, 1));
  return { k, x: (-(x0 + x1) / 2) * k, y: (-(y0 + y1) / 2) * k };
}

/** Number of links per node. */
export function degrees(n: number, edges: [number, number][]): number[] {
  const deg = new Array<number>(n).fill(0);
  for (const [a, b] of edges) {
    deg[a]++;
    deg[b]++;
  }
  return deg;
}
