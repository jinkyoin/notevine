import { describe, expect, it } from "vitest";
import type { TreeNode } from "../api";
import { ancestors, baseName, countNotes, findNode, noteTitle, parentPath, remapPath } from "./tree";

const tree: TreeNode[] = [
  {
    path: "10 업무일지",
    name: "10 업무일지",
    kind: "folder",
    mtime: 0,
    children: [
      {
        path: "10 업무일지/2026",
        name: "2026",
        kind: "folder",
        mtime: 0,
        children: [{ path: "10 업무일지/2026/2026-10-28.md", name: "2026-10-28.md", kind: "note", mtime: 0 }],
      },
      { path: "10 업무일지/첨부.png", name: "첨부.png", kind: "file", mtime: 0 },
      { path: "10 업무일지/메모.md", name: "메모.md", kind: "note", mtime: 0 },
    ],
  },
];

describe("tree helpers", () => {
  it("splits paths", () => {
    expect(parentPath("a/b/c.md")).toBe("a/b");
    expect(parentPath("c.md")).toBe("");
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(noteTitle("a/회의록.MD")).toBe("회의록");
  });

  it("finds nested nodes", () => {
    expect(findNode(tree, "10 업무일지/2026/2026-10-28.md")?.name).toBe("2026-10-28.md");
    expect(findNode(tree, "없음.md")).toBeUndefined();
  });

  it("counts notes recursively, ignoring attachments", () => {
    expect(countNotes(tree[0])).toBe(2);
  });

  it("lists ancestors", () => {
    expect(ancestors("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(ancestors("c.md")).toEqual([]);
  });

  it("remaps moved paths without touching look-alike prefixes", () => {
    expect(remapPath("a/b.md", "a", "x")).toBe("x/b.md");
    expect(remapPath("a", "a", "x")).toBe("x");
    expect(remapPath("ab/c.md", "a", "x")).toBe("ab/c.md");
  });
});
