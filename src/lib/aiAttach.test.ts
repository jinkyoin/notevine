import { describe, expect, it } from "vitest";
import type { TreeNode } from "../api";
import { entriesUnder, isSendableFile } from "./aiAttach";

const n = (path: string, kind: TreeNode["kind"], children?: TreeNode[]): TreeNode => ({ name: path.split("/").pop()!, path, kind, mtime: 0, children });
const tree = [
  n("회의.md", "note"),
  n("프로젝트", "folder", [
    n("프로젝트/계획.md", "note"),
    n("프로젝트/첨부.pdf", "file"),
    n("프로젝트/사진.png", "file"),
    n("프로젝트/세부", "folder", [n("프로젝트/세부/일정.md", "note"), n("프로젝트/세부/예산.XLSX", "file")]),
  ]),
  n("빈 폴더", "folder", []),
  n("그림.jpg", "file"),
];

describe("what a dropped tree entry sends", () => {
  it("a note or a readable file is itself", () => {
    expect(entriesUnder(tree, "회의.md")).toEqual({ notes: ["회의.md"], files: [] });
    expect(entriesUnder(tree, "프로젝트/첨부.pdf")).toEqual({ notes: [], files: ["프로젝트/첨부.pdf"] });
  });

  it("a folder is every note and readable file under it, sub-folders too", () => {
    expect(entriesUnder(tree, "프로젝트")).toEqual({
      notes: ["프로젝트/계획.md", "프로젝트/세부/일정.md"],
      files: ["프로젝트/첨부.pdf", "프로젝트/세부/예산.XLSX"],
    });
  });

  it("an empty folder has none; an unknown path or a picture is null", () => {
    expect(entriesUnder(tree, "빈 폴더")).toEqual({ notes: [], files: [] });
    expect(entriesUnder(tree, "없음.md")).toBeNull();
    expect(entriesUnder(tree, "그림.jpg")).toBeNull();
  });

  it("readable files go by extension", () => {
    expect(isSendableFile("a/제안요청서.PDF")).toBe(true);
    expect(isSendableFile("과업.hwpx")).toBe(true);
    expect(isSendableFile("데이터.csv")).toBe(true);
    expect(isSendableFile("과업.hwp")).toBe(false);
    expect(isSendableFile("압축.zip")).toBe(false);
    expect(isSendableFile("폴더.pdf/이름없음")).toBe(false);
  });
});
