import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { applyColor, safeStyle } from "./colors";

const RED = "#e03131";
const BLUE = "#1c7ed6";

function run(doc: string, from: number, to: number, prop: "color" | "background-color", value: string | null) {
  const s = EditorState.create({ doc, selection: EditorSelection.range(from, to) });
  const next = s.update(applyColor(s, prop, value)).state;
  const r = next.selection.main;
  return { doc: next.doc.toString(), sel: next.sliceDoc(r.from, r.to) };
}

describe("applyColor", () => {
  it("wraps the selection and keeps it selected", () => {
    expect(run("중요한 결정", 0, 3, "color", RED)).toEqual({ doc: `<span style="color: ${RED}">중요한</span> 결정`, sel: "중요한" });
  });

  it("uses the word at the cursor", () => {
    expect(run("a word b", 4, 4, "background-color", "yellow").doc).toBe('a <span style="background-color: yellow">word</span> b');
  });

  it("replaces or removes the same kind, keeps the other kind", () => {
    const colored = `<span style="color: ${RED}">중요</span>`;
    const inner = colored.indexOf("중요");
    expect(run(colored, inner, inner + 2, "color", BLUE).doc).toBe(`<span style="color: ${BLUE}">중요</span>`);
    expect(run(colored, inner, inner + 2, "color", null).doc).toBe("중요");
    expect(run(colored, 0, colored.length, "color", null).doc).toBe("중요");
    expect(run(colored, inner, inner + 2, "background-color", "yellow").doc).toBe(
      `<span style="color: ${RED}"><span style="background-color: yellow">중요</span></span>`,
    );
  });

  it("colors each line separately and leaves list markers outside", () => {
    const doc = "- 첫째\n- 둘째";
    expect(run(doc, 0, doc.length, "color", RED).doc).toBe(`- <span style="color: ${RED}">첫째</span>\n- <span style="color: ${RED}">둘째</span>`);
  });

  it("removes a color from a line holding spans of both kinds", () => {
    const doc = `<span style="color: ${RED}">빨강</span> <span style="background-color: yellow">노랑</span>`;
    expect(run(doc, 0, doc.length, "color", null).doc).toBe('빨강 <span style="background-color: yellow">노랑</span>');
  });

  it("merges colored parts inside a larger selection", () => {
    const doc = `a <span style="color: ${RED}">b</span> c`;
    expect(run(doc, 0, doc.length, "color", BLUE).doc).toBe(`<span style="color: ${BLUE}">a b c</span>`);
  });
});

describe("safeStyle", () => {
  it("keeps only plain colors", () => {
    expect(safeStyle("color: #e03131")).toBe("color: #e03131");
    expect(safeStyle("background: rgba(255, 212, 59, 0.45)")).toBe("background-color: rgba(255, 212, 59, 0.45)");
    expect(safeStyle("color: red; position: fixed")).toBe("color: red");
    expect(safeStyle("background: url(https://x.y/a.png)")).toBeNull();
    expect(safeStyle("color: expression(alert(1))")).toBeNull();
  });
});
