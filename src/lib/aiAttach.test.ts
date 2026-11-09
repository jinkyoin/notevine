import { describe, expect, it } from "vitest";
import type { TreeNode } from "../api";
import { notesUnder } from "./aiAttach";

const n = (path: string, kind: TreeNode["kind"], children?: TreeNode[]): TreeNode => ({ name: path.split("/").pop()!, path, kind, mtime: 0, children });
const tree = [
  n("회의.md", "note"),
  n("프로젝트", "folder", [n("프로젝트/계획.md", "note"), n("프로젝트/첨부.pdf", "file"), n("프로젝트/세부", "folder", [n("프로젝트/세부/일정.md", "note")])]),
  n("빈 폴더", "folder", []),
];

describe("notes a dropped tree entry stands for", () => {
  it("a note is itself", () => {
    expect(notesUnder(tree, "회의.md")).toEqual(["회의.md"]);
  });

  it("a folder is every note under it, sub-folders too, and no other files", () => {
    expect(notesUnder(tree, "프로젝트")).toEqual(["프로젝트/계획.md", "프로젝트/세부/일정.md"]);
  });

  it("an empty folder has none; an unknown path or a non-note file is null", () => {
    expect(notesUnder(tree, "빈 폴더")).toEqual([]);
    expect(notesUnder(tree, "없음.md")).toBeNull();
    expect(notesUnder(tree, "프로젝트/첨부.pdf")).toBeNull();
  });
});
