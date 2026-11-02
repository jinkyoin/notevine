import { describe, expect, it } from "vitest";
import { degrees, initialLayout, stepLayout } from "./graphLayout";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("graph layout", () => {
  it("pulls linked notes together and keeps unlinked ones apart", () => {
    const pts = initialLayout(4);
    const edges: [number, number][] = [[0, 1]];
    for (let t = 0; t < 300; t++) stepLayout(pts, edges, 1 - t / 300);
    expect(dist(pts[0], pts[1])).toBeLessThan(dist(pts[2], pts[3]));
    for (const p of pts) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it("separates notes that start on the same spot", () => {
    const pts = [
      { x: 0, y: 0, vx: 0, vy: 0 },
      { x: 0, y: 0, vx: 0, vy: 0 },
    ];
    stepLayout(pts, [], 1);
    expect(dist(pts[0], pts[1])).toBeGreaterThan(0);
  });

  it("counts links per note", () => {
    expect(degrees(3, [[0, 1], [0, 2]])).toEqual([2, 1, 1]);
  });
});
