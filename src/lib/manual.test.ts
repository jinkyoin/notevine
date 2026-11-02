import { describe, expect, it } from "vitest";
import { headingSlug, MANUAL, manualChapters } from "./manual";

describe("manual", () => {
  it("makes GitHub-style anchors", () => {
    expect(headingSlug("4. 노트 연결하기: 링크·태그·속성")).toBe("4-노트-연결하기-링크태그속성");
    expect(headingSlug("9.3 삭제된 노트 되살리기")).toBe("93-삭제된-노트-되살리기");
    expect(headingSlug("6. 폴더 보기: 표·보드·캘린더·그래프")).toBe("6-폴더-보기-표보드캘린더그래프");
  });

  it("lists the chapters, and every link inside the manual has a heading to go to", () => {
    const chapters = manualChapters();
    expect(chapters[0].title).toBe("1. 시작하기");
    expect(chapters.length).toBeGreaterThanOrEqual(13);
    const slugs = new Set(
      MANUAL.split("\n")
        .filter((l) => /^#{2,4} /.test(l))
        .map((l) => headingSlug(l.replace(/^#+ /, ""))),
    );
    const links = [...MANUAL.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(10);
    expect(links.filter((l) => !slugs.has(l))).toEqual([]);
  });
});
