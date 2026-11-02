import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { koDate } from "./koDate";

const md = markdown({ base: markdownLanguage, extensions: [koDate] });

function nodes(doc: string) {
  const state = EditorState.create({ doc, extensions: md });
  const names: string[] = [];
  ensureSyntaxTree(state, doc.length, 5000)!.iterate({ enter: (n) => void names.push(n.name) });
  return names;
}

describe("koDate", () => {
  it("reads a line starting with a Korean date as text, not a list", () => {
    const names = nodes("# 일정\n\n2026. 06. 22 ~ 2029. 06. 21\n     \n# 대금\n");
    expect(names).not.toContain("OrderedList");
    expect(names).toContain("Paragraph");
    expect(nodes("2026.6.22 **마감**")).toContain("StrongEmphasis");
    expect(nodes("1. 첫째\n2. 둘째")).toContain("OrderedList");
  });

  it("doesn't continue a date line as a list on Enter", () => {
    const doc = "2026. 06. 22 ~ 2029. 06. 21";
    const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: md });
    ensureSyntaxTree(state, doc.length, 5000);
    // false: not list markup, so Enter falls back to a plain new line.
    expect(insertNewlineContinueMarkup({ state, dispatch: () => {} })).toBe(false);
    const list = EditorState.create({ doc: "1. 첫째", selection: { anchor: 5 }, extensions: md });
    ensureSyntaxTree(list, 5, 5000);
    expect(insertNewlineContinueMarkup({ state: list, dispatch: () => {} })).toBe(true);
  });
});
