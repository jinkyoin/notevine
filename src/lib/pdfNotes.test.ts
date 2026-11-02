import { describe, expect, it } from "vitest";
import { annotationEntry, annotationNote, annotationPath, parseAnnotations, quoteSpans } from "./pdfNotes";
import { noteToHtml } from "./renderNote";

describe("PDF annotations", () => {
  const pdf = "첨부/사업수행계획서.pdf";

  it("live next to the PDF and start with a link to it", () => {
    expect(annotationPath(pdf)).toBe("첨부/사업수행계획서 주석.md");
    expect(annotationPath("a.PDF")).toBe("a 주석.md");
    const note = annotationNote(pdf, "2026-11-02");
    expect(note).toContain('source: "[[첨부/사업수행계획서.pdf]]"');
    expect(note).toContain("# 사업수행계획서 주석");
  });

  it("are written as linked boxes and read back", () => {
    const text =
      annotationNote(pdf, "2026-11-02") +
      annotationEntry(pdf, 3, "  착수보고는\n계약 후 14일 이내  ", "일정표에 넣기") +
      annotationEntry(pdf, 12, "하자보수 기간 1년", "");
    expect(text).toContain("> [!참고] [[첨부/사업수행계획서.pdf#page=3|p.3]]\n> 착수보고는 계약 후 14일 이내\n\n일정표에 넣기\n");
    expect(parseAnnotations(text)).toEqual([
      { page: 3, quote: "착수보고는 계약 후 14일 이내", memo: "일정표에 넣기" },
      { page: 12, quote: "하자보수 기간 1년", memo: "" },
    ]);
    // In the reading view the box title is a link to the page.
    expect(noteToHtml(text)).toContain('data-target="첨부/사업수행계획서.pdf" data-heading="page=3">p.3</a>');
  });

  it("find the PDF text pieces a quote covers, whatever the spacing", () => {
    const pieces = ["제3조 ", "착수보고", "는 계약 후 ", "14일", " 이내에 제출한다."];
    expect(quoteSpans(pieces, "착수보고는 계약 후 14일 이내")).toEqual([1, 2, 3, 4]);
    expect(quoteSpans(pieces, "없는 글")).toEqual([]);
    expect(quoteSpans(pieces, "제")).toEqual([]);
  });
});
