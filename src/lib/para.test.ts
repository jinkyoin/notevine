import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../store";
import { paraActions } from "./para";

const all = (_folder: string) => true;
const labels = (path: string, isFolder: boolean, exists: (folder: string) => boolean = all) => paraActions(path, isFolder, DEFAULT_CONFIG, exists).map((a) => a.label);

describe("PARA actions in the file tree menu", () => {
  it("offers a new project on the project folder", () => {
    expect(labels("10.프로젝트", true)).toEqual(["새 프로젝트"]);
  });

  it("archives notes and folders outside the archive", () => {
    expect(labels("10.프로젝트/홈페이지 개편", true)).toEqual(["보관으로 옮기기"]);
    expect(labels("20.영역/업무일지/2026/2026-10-30.md", false)).toEqual(["보관으로 옮기기"]);
    expect(labels("메모.md", false)).toEqual(["보관으로 옮기기"]);
  });

  it("leaves the structure's own folders alone", () => {
    for (const root of ["00.Inbox", "20.영역", "30.자료", "40.보관", "90.템플릿", "첨부"]) expect(labels(root, true)).toEqual([]);
  });

  it("takes archived things out to the folders that exist", () => {
    expect(labels("40.보관/홈페이지 개편", true)).toEqual(["프로젝트로 꺼내기", "영역으로 꺼내기", "자료로 꺼내기"]);
    expect(labels("40.보관/a/b.md", false, (f) => f !== "20.영역")).toEqual(["프로젝트로 꺼내기", "자료로 꺼내기"]);
  });

  it("offers no archiving without an archive folder", () => {
    expect(labels("10.프로젝트/홈페이지 개편", true, (f) => f !== "40.보관")).toEqual([]);
  });
});
