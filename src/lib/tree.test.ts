import { describe, expect, it } from "vitest";
import type { TreeNode } from "../api";
import { ancestors, baseName, countNotes, findNode, moveTargets, noteTitle, parentPath, remapPath, treeKeyAction } from "./tree";

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

describe("moveTargets", () => {
  const folder = (path: string, children: TreeNode[] = []): TreeNode => ({ kind: "folder", path, name: path.split("/").pop()!, children }) as TreeNode;
  const note = (path: string): TreeNode => ({ kind: "note", path, name: path.split("/").pop()! }) as TreeNode;
  const tree = [folder("a", [folder("a/b", [note("a/b/n.md")]), note("a/m.md")]), folder("c"), note("t.md")];

  it("offers every folder but where a note already is", () => {
    expect(moveTargets(tree, "t.md")).toEqual(["a", "a/b", "c"]);
    expect(moveTargets(tree, "a/b/n.md")).toEqual(["", "a", "c"]);
  });
  it("keeps a folder out of itself and what is below it", () => {
    expect(moveTargets(tree, "a")).toEqual(["c"]);
    expect(moveTargets(tree, "a/b")).toEqual(["", "c"]);
  });
  it("has nowhere to go when there are no other folders", () => {
    expect(moveTargets([note("t.md")], "t.md")).toEqual([]);
  });
});

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

describe("treeKeyAction", () => {
  it("deletes the selected row on Delete and opens it on Enter", () => {
    expect(treeKeyAction("Delete", false, "a.md")).toBe("delete");
    expect(treeKeyAction("Enter", false, "a.md")).toBe("open");
  });
  it("leaves typing in the name box and an empty selection alone", () => {
    expect(treeKeyAction("Delete", true, "a.md")).toBeNull();
    expect(treeKeyAction("Enter", true, "a.md")).toBeNull();
    expect(treeKeyAction("Delete", false, null)).toBeNull();
    expect(treeKeyAction("Backspace", false, "a.md")).toBeNull();
  });
});
