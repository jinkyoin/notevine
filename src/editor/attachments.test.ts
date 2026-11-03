import { describe, expect, it } from "vitest";
import { attachmentLink, inlineSpot, linkFor, pastedImageName } from "./attachments";

describe("attachments", () => {
  it("names pasted images by time", () => {
    expect(pastedImageName(new Date(2026, 9, 28, 14, 32, 1))).toBe("이미지 20261028-143201.png");
    expect(pastedImageName(new Date(2026, 0, 2, 3, 4, 5), "jpg")).toBe("이미지 20260102-030405.jpg");
  });

  it("embeds images and links other files", () => {
    expect(attachmentLink("첨부/구조도.PNG")).toBe("![[첨부/구조도.PNG]]");
    expect(attachmentLink("첨부/견적서.xlsx")).toBe("[[첨부/견적서.xlsx]]");
  });

  it("links a file dragged from the tree like link completion does", () => {
    const notes = [
      { path: "회의/주간 회의.md", title: "주간 회의" },
      { path: "a/메모.md", title: "메모" },
      { path: "b/메모.md", title: "메모" },
    ];
    expect(linkFor("회의/주간 회의.md", notes)).toBe("[[주간 회의]]");
    expect(linkFor("b/메모.md", notes)).toBe("[[b/메모]]");
    expect(linkFor("첨부/사진.png", notes)).toBe("![[첨부/사진.png]]");
    expect(linkFor("자료/견적서.xlsx", notes)).toBe("[[자료/견적서.xlsx]]");
  });

  it("drops a link between words, never inside one", () => {
    expect(inlineSpot("첫 줄", 1)).toEqual({ col: 1, before: " ", after: "" });
    expect(inlineSpot("회의록입니다 끝", 1)).toEqual({ col: 0, before: "", after: " " });
    expect(inlineSpot("회의록입니다 끝", 5)).toEqual({ col: 6, before: " ", after: "" });
    expect(inlineSpot("끝", 9)).toEqual({ col: 1, before: " ", after: "" });
    expect(inlineSpot("", 0)).toEqual({ col: 0, before: "", after: "" });
  });
});
