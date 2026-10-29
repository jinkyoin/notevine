import { describe, expect, it } from "vitest";
import { findHeadingLine, headingKey } from "./headings";

describe("findHeadingLine", () => {
  const note = ["---", "title: x", "# 속성 안", "---", "# 회의록", "", "## 결정 사항", "```", "## 코드 안", "```", "### **굵은** 제목 ##"].join("\n");

  it("finds a heading by its text, ignoring case and markdown marks", () => {
    expect(findHeadingLine(note, "결정 사항")).toBe(7);
    expect(findHeadingLine(note, "  결정   사항 ")).toBe(7);
    expect(findHeadingLine(note, "굵은 제목")).toBe(11);
    expect(findHeadingLine("# Plan\n", "plan")).toBe(1);
  });

  it("skips frontmatter and code blocks", () => {
    expect(findHeadingLine(note, "속성 안")).toBeNull();
    expect(findHeadingLine(note, "코드 안")).toBeNull();
  });

  it("returns null for a missing or empty heading", () => {
    expect(findHeadingLine(note, "없는 제목")).toBeNull();
    expect(findHeadingLine(note, "")).toBeNull();
  });

  it("handles CRLF", () => {
    expect(findHeadingLine("a\r\n## 둘\r\n", "둘")).toBe(2);
  });
});

describe("headingKey", () => {
  it("compares rendered text with the source", () => {
    expect(headingKey("**굵은** `코드`")).toBe(headingKey("굵은 코드"));
  });
});
