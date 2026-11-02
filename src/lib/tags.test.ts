import { describe, expect, it } from "vitest";
import { rankTags, tagBefore } from "./tags";
import { noteToHtml } from "./renderNote";

describe("tagBefore", () => {
  it("finds the tag being typed", () => {
    expect(tagBefore("오늘 #회")).toBe("회");
    expect(tagBefore("#프로젝트/웹")).toBe("프로젝트/웹");
    expect(tagBefore("(#a_b-c")).toBe("a_b-c");
    expect(tagBefore("글 #")).toBe("");
  });

  it("skips a # glued to a word, URL or path", () => {
    expect(tagBefore("C#")).toBeNull();
    expect(tagBefore("회의록#결정")).toBeNull();
    expect(tagBefore("https://a.com/#top")).toBeNull();
    expect(tagBefore("##두번")).toBeNull();
    expect(tagBefore("그냥 글")).toBeNull();
    expect(tagBefore("#회의 다음")).toBeNull();
    expect(tagBefore('<span style="color: #1c')).toBeNull();
    expect(tagBefore('<span style="color: #1c7ed6">글</span> #회')).toBe("회");
    expect(tagBefore("a < #b")).toBe("b");
  });
});

describe("read mode", () => {
  it("doesn't turn a color inside HTML into a tag", () => {
    const html = noteToHtml('<span style="color: #1c7ed6">2026. 11. 30</span> #진짜');
    expect(html).not.toContain('data-tag="1c7ed6"');
    expect(html).toContain('data-tag="진짜"');
  });
});

describe("rankTags", () => {
  const tags = [
    { tag: "업무", count: 2 },
    { tag: "회의", count: 5 },
    { tag: "회의록", count: 1 },
    { tag: "주간회의", count: 9 },
  ];

  it("puts prefix matches first, most used first, and leaves out the exact tag", () => {
    expect(rankTags(tags, "회").map((t) => t.tag)).toEqual(["회의", "회의록", "주간회의"]);
    expect(rankTags(tags, "회의").map((t) => t.tag)).toEqual(["회의록", "주간회의"]);
    expect(rankTags(tags, "").map((t) => t.tag)).toEqual(["주간회의", "회의", "업무", "회의록"]);
    expect(rankTags(tags, "없음")).toEqual([]);
  });
});
