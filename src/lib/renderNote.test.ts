import { describe, expect, it } from "vitest";
import { noteToHtml, toggleTask } from "./renderNote";

describe("noteToHtml", () => {
  it("renders standard markdown and drops the properties block", () => {
    const html = noteToHtml("---\ntags: [a]\n---\n# 제목\n\n**굵게** *기울임* ~~취소~~ `코드`\n\n> 인용\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(html).not.toContain("tags:");
    expect(html).toContain("<h1>제목</h1>");
    expect(html).toContain("<strong>굵게</strong>");
    expect(html).toContain("<em>기울임</em>");
    expect(html).toContain("<del>취소</del>");
    expect(html).toContain("<code>코드</code>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
  });

  it("turns Notevine syntax into clickable elements", () => {
    const html = noteToHtml("[[회의록#결정|지난 회의]] ![[그림.png|300]] ==중요== #업무/기획 a#b\n[문서](https://x.y) [노트](../a.md)");
    expect(html).toContain('<a href="#" class="wikilink" data-target="회의록">지난 회의</a>');
    expect(html).toContain('<img data-embed="그림.png" alt="그림.png" width="300">');
    expect(html).toContain("<mark>중요</mark>");
    expect(html).toContain('data-tag="업무/기획"');
    expect(html).not.toContain('data-tag="b"');
    expect(html).toContain('data-url="https://x.y"');
    expect(html).toContain('data-dest="../a.md"');
  });

  it("never points an image at the web", () => {
    const html = noteToHtml("![로고](https://x.y/a.png) ![로컬](첨부/a.png)");
    expect(html).not.toMatch(/<img[^>]+src=/);
    expect(html).toContain('data-url="https://x.y/a.png"');
    expect(html).toContain('data-embed="첨부/a.png"');
  });

  it("keeps color spans and the markdown inside them", () => {
    const html = noteToHtml('<span style="color: #e03131">**중요**</span> <span style="background-color: yellow">[[회의록]]</span>');
    expect(html).toContain('<span style="color: #e03131"><strong>중요</strong></span>');
    expect(html).toContain('<span style="background-color: yellow"><a href="#" class="wikilink" data-target="회의록">회의록</a></span>');
  });

  it("leaves code alone", () => {
    const html = noteToHtml("```\n[[아님]] #아님\n```\n`==아님==`");
    expect(html).not.toContain("wikilink");
    expect(html).not.toContain("data-tag");
    expect(html).not.toContain("<mark>");
  });

  it("renders enabled task boxes", () => {
    const html = noteToHtml("- [ ] 할 일\n- [x] 한 일\n");
    expect(html.match(/class="task"/g)?.length).toBe(2);
    expect(html).not.toContain("disabled");
  });
});

describe("toggleTask", () => {
  it("flips the n-th task, skipping code and frontmatter", () => {
    const src = "---\nt: - [ ] no\n---\n- [ ] a\n```\n- [ ] code\n```\n  1. [x] b\n> - [ ] c\n";
    expect(toggleTask(src, 0)).toBe(src.replace("- [ ] a", "- [x] a"));
    expect(toggleTask(src, 1)).toBe(src.replace("1. [x] b", "1. [ ] b"));
    expect(toggleTask(src, 2)).toBe(src.replace("> - [ ] c", "> - [x] c"));
    expect(toggleTask(src, 3)).toBeNull();
  });
});
