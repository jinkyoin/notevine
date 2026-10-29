import { describe, expect, it } from "vitest";
import { insertTemplate } from "./template";

const TPL = "---\ntype: meeting\ntags: [회의]\n---\n\n# 회의\n\n- 일시: 2026-10-29\n";

describe("insertTemplate", () => {
  it("adds the template's properties and body to an empty note", () => {
    const r = insertTemplate("", 0, TPL);
    expect(r.text).toBe("---\ntype: meeting\ntags: [회의]\n---\n# 회의\n\n- 일시: 2026-10-29");
    expect(r.cursor).toBe(r.text.length);
  });

  it("inserts the body at the cursor on lines of its own", () => {
    const note = "첫 줄\n끝";
    const r = insertTemplate(note, 2, "본문");
    expect(r.text).toBe("첫 \n본문\n줄\n끝");
    expect(r.text.slice(0, r.cursor)).toBe("첫 \n본문");
  });

  it("keeps existing property values and adds only missing keys", () => {
    const note = "---\ntags: [기존]\n---\n내용\n";
    const r = insertTemplate(note, note.length, TPL);
    expect(r.text).toBe("---\ntags: [기존]\ntype: meeting\n---\n내용\n# 회의\n\n- 일시: 2026-10-29");
  });

  it("puts the body below the properties when the cursor is inside them", () => {
    const note = "---\na: 1\n---\n본문";
    const r = insertTemplate(note, 4, "# 제목");
    expect(r.text).toBe("---\na: 1\n---\n# 제목\n본문");
  });

  it("leaves broken note YAML untouched", () => {
    const note = "---\na: [\n---\n";
    const r = insertTemplate(note, note.length, TPL);
    expect(r.text.startsWith("---\na: [\n---\n# 회의")).toBe(true);
  });

  it("fills an empty properties block", () => {
    const r = insertTemplate("---\n---\n", 8, TPL);
    expect(r.text).toBe("---\ntype: meeting\ntags: [회의]\n---\n# 회의\n\n- 일시: 2026-10-29");
  });

  it("keeps CRLF line endings", () => {
    const r = insertTemplate("a\r\nb", 1, "x\ny");
    expect(r.text).toBe("a\r\nx\r\ny\r\nb");
  });
});
