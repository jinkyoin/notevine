import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { callout, codeBlock, insertBlock, toggleLines, toggleWrap, webLink, wikiLink } from "./format";
import { CALLOUTS } from "../lib/callout";

/** Text with "|" as the cursor or "[" "]" around a selection, e.g. "a [bc] d". */
function st(src: string) {
  const a = src.indexOf("[");
  if (a >= 0 && src.includes("]")) {
    const doc = src.replace("[", "").replace("]", "");
    const b = src.indexOf("]") - 1;
    return EditorState.create({ doc, selection: EditorSelection.range(a, b), extensions: EditorState.allowMultipleSelections.of(true) });
  }
  const c = src.indexOf("|");
  return EditorState.create({ doc: src.replace("|", ""), selection: EditorSelection.cursor(Math.max(c, 0)) });
}

function run(s: EditorState, f: (s: EditorState) => TransactionSpec) {
  const next = s.update(f(s)).state;
  const r = next.selection.main;
  return { doc: next.doc.toString(), sel: next.sliceDoc(r.from, r.to), head: r.head };
}

describe("format", () => {
  it("wraps and unwraps a selection", () => {
    expect(run(st("a [bc] d"), (s) => toggleWrap(s, "**"))).toMatchObject({ doc: "a **bc** d", sel: "bc" });
    expect(run(st("a **[bc]** d"), (s) => toggleWrap(s, "**"))).toMatchObject({ doc: "a bc d", sel: "bc" });
    expect(run(st("a [**bc**] d"), (s) => toggleWrap(s, "**"))).toMatchObject({ doc: "a bc d", sel: "bc" });
  });

  it("keeps spaces at the edges of the selection outside the marks", () => {
    expect(run(st("a[ 품질 관리 ]b"), (s) => toggleWrap(s, "~~"))).toMatchObject({ doc: "a ~~품질 관리~~ b", sel: "품질 관리" });
    expect(run(st("[  ]"), (s) => toggleWrap(s, "**")).doc).toBe("  ****");
  });

  it("wraps the word at the cursor, or inserts a pair", () => {
    expect(run(st("hello wo|rld"), (s) => toggleWrap(s, "*")).doc).toBe("hello *world*");
    const r = run(st("a | b"), (s) => toggleWrap(s, "~~"));
    expect(r.doc).toBe("a ~~~~ b");
    expect(r.head).toBe(4);
    expect(run(st("x |"), wikiLink)).toMatchObject({ doc: "x [[]]", head: 4 });
  });

  it("toggles headings and replaces one level with another", () => {
    expect(run(st("제|목"), (s) => toggleLines(s, "h2")).doc).toBe("## 제목");
    expect(run(st("## 제|목"), (s) => toggleLines(s, "h2")).doc).toBe("제목");
    expect(run(st("## 제|목"), (s) => toggleLines(s, "h1")).doc).toBe("# 제목");
  });

  it("toggles lists over several lines, numbering and keeping blank lines", () => {
    expect(run(st("[a\nb\n\nc]"), (s) => toggleLines(s, "number")).doc).toBe("1. a\n2. b\n\n3. c");
    expect(run(st("[- a\n- b]"), (s) => toggleLines(s, "bullet")).doc).toBe("a\nb");
    expect(run(st("[- a\n- b]"), (s) => toggleLines(s, "task")).doc).toBe("- [ ] a\n- [ ] b");
    const task = EditorState.create({ doc: "- [ ] a", selection: EditorSelection.cursor(6) });
    expect(run(task, (s) => toggleLines(s, "task")).doc).toBe("a");
    expect(run(st("  - |a"), (s) => toggleLines(s, "number")).doc).toBe("  1. a");
    expect(run(st("|인용"), (s) => toggleLines(s, "quote")).doc).toBe("> 인용");
  });

  it("inserts blocks on their own lines", () => {
    expect(run(st("abc|"), (s) => insertBlock(s, "---")).doc).toBe("abc\n\n---\n");
    expect(run(st("|"), (s) => insertBlock(s, "---")).doc).toBe("---\n");
    const r = run(st("|"), codeBlock);
    expect(r.doc).toBe("```\n\n```\n");
    expect(r.head).toBe(4);
    expect(run(st("[x = 1]"), codeBlock).doc).toBe("```\nx = 1\n```");
  });

  it("makes a web link with the url selected", () => {
    expect(run(st("[문서]"), webLink)).toMatchObject({ doc: "[문서](url)", sel: "url" });
  });

  it("puts lines in a callout box, changes its type, and takes it away", () => {
    const [important, warning] = CALLOUTS;
    const box = (s: EditorState) => callout(s, important);
    expect(run(st("|"), box)).toMatchObject({ doc: "> [!중요]\n> ", head: 10 });
    expect(run(st("계약 |금액"), box).doc).toBe("> [!중요]\n> 계약 금액");
    expect(run(st("[가\n\n나]"), box).doc).toBe("> [!중요]\n> 가\n>\n> 나");
    // "[!…]" would read as a selection in st(): the cursor goes at the start here.
    const at = (doc: string) => EditorState.create({ doc });
    expect(run(at("> [!중요]\n> 가"), (s) => callout(s, warning)).doc).toBe("> [!주의]\n> 가");
    expect(run(at("> [!중요]\n> 가\n\n다"), box).doc).toBe("가\n\n다");
    expect(run(at("> [!중요] 제목\n> 가"), box).doc).toBe("제목\n가");
  });
});
