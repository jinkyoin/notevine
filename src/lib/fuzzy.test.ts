import { describe, expect, it } from "vitest";
import { rankNotes } from "./fuzzy";

const notes = [
  { path: "30 조사자료/화면 설계 회의록 1027.md", title: "화면 설계 회의록 1027" },
  { path: "docs/화면 설계서.md", title: "화면 설계서" },
  { path: "일지/회의록.md", title: "회의록" },
  { path: "아이디어.md", title: "아이디어" },
];

describe("rankNotes", () => {
  it("prefers prefix, then substring, then subsequence", () => {
    expect(rankNotes(notes, "회의", []).map((n) => n.title)).toEqual(["회의록", "화면 설계 회의록 1027"]);
    expect(rankNotes(notes, "화면", []).map((n) => n.title)).toEqual(["화면 설계서", "화면 설계 회의록 1027"]);
    expect(rankNotes(notes, "화설서", []).map((n) => n.title)).toEqual(["화면 설계서"]);
  });

  it("lists recently opened notes first when the query is empty", () => {
    expect(rankNotes(notes, "", ["아이디어.md", "일지/회의록.md"]).slice(0, 2).map((n) => n.title)).toEqual([
      "아이디어",
      "회의록",
    ]);
  });

  it("matches folder names and ignores case and NFD", () => {
    expect(rankNotes(notes, "DOCS", []).map((n) => n.title)).toEqual(["화면 설계서"]);
    expect(rankNotes(notes, "아이디".normalize("NFD"), []).map((n) => n.title)).toEqual(["아이디어"]);
  });
});
