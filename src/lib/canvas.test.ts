import { describe, expect, it } from "vitest";
import {
  addEdge,
  addNode,
  anchor,
  dragSet,
  edgeEnds,
  facingSide,
  fitView,
  freeSpot,
  hitNode,
  moveNodes,
  parseCanvas,
  removeItems,
  resizeNode,
  serializeCanvas,
  type Canvas,
} from "./canvas";

const text = (id: string, x: number, y: number, w = 100, h = 50) => ({ id, type: "text" as const, text: id, x, y, width: w, height: h });

describe("canvas", () => {
  it("reads a board leniently and keeps unknown fields", () => {
    const c = parseCanvas(
      JSON.stringify({
        nodes: [text("a", 0, 0), { id: "b", type: "file", file: "노트.md", x: 10, y: 10, width: 5, height: 5 }, { id: "c", type: "?" }, { type: "text" }],
        edges: [{ id: "e", fromNode: "a", toNode: "b" }, { id: "x", fromNode: "a", toNode: "없음" }],
        extra: 1,
      }),
    );
    expect(c.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(c.nodes[1]).toMatchObject({ width: 80, height: 40 });
    expect(c.edges.map((e) => e.id)).toEqual(["e"]);
    expect(JSON.parse(serializeCanvas(c)).extra).toBe(1);
    expect(parseCanvas("")).toEqual({ nodes: [], edges: [] });
    expect(() => parseCanvas("{깨짐")).toThrow();
  });

  it("adds, moves, resizes and removes cards with their lines", () => {
    let c: Canvas = { nodes: [], edges: [] };
    c = addNode(c, text("a", 0, 0));
    c = addNode(c, text("b", 300, 0));
    c = addNode(c, { id: "g", type: "group", label: "묶음", x: -10, y: -10, width: 500, height: 100 });
    expect(c.nodes[0].id).toBe("g"); // groups are drawn first
    c = addEdge(c, "a", "right", "b", "left");
    expect(addEdge(c, "a", "right", "b", "left")).toBe(c);
    expect(addEdge(c, "b", "left", "a", "right")).toBe(c);
    expect(addEdge(c, "a", "right", "a", "left")).toBe(c);
    c = moveNodes(c, new Set(["a"]), 10.4, 5);
    expect(c.nodes.find((n) => n.id === "a")).toMatchObject({ x: 10, y: 5 });
    c = resizeNode(c, "a", 10, 500);
    expect(c.nodes.find((n) => n.id === "a")).toMatchObject({ width: 80, height: 500 });
    c = removeItems(c, new Set(["b"]));
    expect(c.nodes.map((n) => n.id)).toEqual(["g", "a"]);
    expect(c.edges).toEqual([]);
  });

  it("drags a group with what lies inside it", () => {
    const c: Canvas = {
      nodes: [{ id: "g", type: "group", x: 0, y: 0, width: 400, height: 200 }, text("in", 10, 10), text("out", 500, 10)],
      edges: [],
    };
    expect([...dragSet(c, new Set(["g"]))].sort()).toEqual(["g", "in"]);
    expect(hitNode(c.nodes, { x: 20, y: 20 })?.id).toBe("in");
    expect(hitNode(c.nodes, { x: 300, y: 150 })?.id).toBe("g");
    expect(hitNode(c.nodes, { x: 450, y: 150 })).toBeNull();
  });

  it("attaches lines to the facing sides", () => {
    const a = { x: 0, y: 0, width: 100, height: 50 };
    const b = { x: 300, y: 10, width: 100, height: 50 };
    expect(anchor(a, "right")).toEqual({ x: 100, y: 25 });
    expect(facingSide(a, { x: 50, y: -100 })).toBe("top");
    expect(edgeEnds(a, b, {})).toMatchObject({ fromSide: "right", toSide: "left", a: { x: 100, y: 25 }, b: { x: 300, y: 35 } });
    expect(edgeEnds(a, b, { fromSide: "bottom" }).fromSide).toBe("bottom");
  });

  it("puts a new card beside the cards it would cover", () => {
    const nodes = [text("a", 0, 0, 200, 100), text("b", 240, 0, 100, 100)];
    expect(freeSpot(nodes, { x: 50, y: 20, width: 100, height: 50 })).toMatchObject({ x: 380, y: 20 });
    expect(freeSpot(nodes, { x: 0, y: 300, width: 100, height: 50 })).toMatchObject({ x: 0, y: 300 });
  });

  it("fits the board into the view without zooming past 100%", () => {
    expect(fitView({ x: 0, y: 0, width: 100, height: 100 }, 1000, 800)).toEqual({ zoom: 1, x: 450, y: 350 });
    expect(fitView({ x: 0, y: 0, width: 4000, height: 100 }, 1000, 800).zoom).toBeCloseTo(0.22);
    expect(fitView(null, 1000, 800)).toEqual({ zoom: 1, x: 500, y: 400 });
  });
});
