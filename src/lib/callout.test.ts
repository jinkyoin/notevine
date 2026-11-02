import { describe, expect, it } from "vitest";
import { calloutHead } from "./callout";
import { noteToHtml } from "./renderNote";

describe("calloutHead", () => {
  it("reads the type and title", () => {
    expect(calloutHead("[!중요] 계약 조건")).toMatchObject({ type: { kind: "important" }, title: "계약 조건", markLen: 5 });
    expect(calloutHead("[!주의]")).toMatchObject({ type: { kind: "warning" }, title: "" });
    expect(calloutHead("[!WARNING]- 접힘")).toMatchObject({ type: { kind: "warning" }, title: "접힘", markLen: 11 });
    expect(calloutHead("[!tip]")?.type.label).toBe("팁");
    expect(calloutHead("[!모름]")?.type.kind).toBe("note");
    expect(calloutHead("그냥 인용")).toBeNull();
    expect(calloutHead("[!중요]뒤에 붙음")).toBeNull();
  });
});

describe("callouts in the reading view", () => {
  it("draw a colored box with a title and body", () => {
    const html = noteToHtml("> [!중요]\n> 계약 금액은 **연도별**로 정한다.\n> - 1차년도\n");
    expect(html).toContain('class="callout callout-important"');
    expect(html).toContain("</span>중요</div>");
    expect(html).toContain("<strong>연도별</strong>");
    expect(html).toContain("<li>1차년도</li>");
    expect(html).not.toContain("<blockquote>");
  });

  it("use the written title, and leave plain quotes alone", () => {
    expect(noteToHtml("> [!주의] 마감 *임박*")).toContain("</span>마감 <em>임박</em></div>");
    expect(noteToHtml("> 그냥 인용")).toContain("<blockquote>");
  });
});
