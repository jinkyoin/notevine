// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { parseSheet } from "../lib/sheet";
import { findSheetBlocks, flushSheetEdits, sheetBlock, sheetEdit } from "./sheetBlock";

function stateOf(doc: string) {
  const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

const FENCE = "```";

describe("findSheetBlocks", () => {
  it("finds a top-level sheet block and its body", () => {
    const doc = `앞\n\n${FENCE}sheet\na | b\n1 | 2\n${FENCE}\n\n뒤`;
    const state = stateOf(doc);
    const blocks = findSheetBlocks(state);
    expect(blocks).toHaveLength(1);
    const [b] = blocks;
    expect(state.sliceDoc(b.bodyFrom, b.bodyTo)).toBe("a | b\n1 | 2");
    expect(state.sliceDoc(b.from, b.to)).toBe(`${FENCE}sheet\na | b\n1 | 2\n${FENCE}`);
  });

  it("finds several blocks in order", () => {
    const doc = `${FENCE}sheet\na\n${FENCE}\n\n글\n\n${FENCE}sheet\nb | c\n${FENCE}\n`;
    const state = stateOf(doc);
    const bodies = findSheetBlocks(state).map((b) => state.sliceDoc(b.bodyFrom, b.bodyTo));
    expect(bodies).toEqual(["a", "b | c"]);
  });

  it("ignores blocks in lists or quotes, ~~~ fences, four-backtick fences, other languages and empty blocks", () => {
    const docs = [
      `- ${FENCE}sheet\n  a | b\n  ${FENCE}\n`,
      `> ${FENCE}sheet\n> a | b\n> ${FENCE}\n`,
      "~~~sheet\na | b\n~~~\n",
      "````sheet\na | b\n````\n",
      `${FENCE}js\na | b\n${FENCE}\n`,
      `${FENCE}sheet\n${FENCE}\n`,
      `${FENCE}sheet\n   \n${FENCE}\n`,
      `${FENCE}sheet\na | b\n`, // never closed
    ];
    for (const doc of docs) expect(findSheetBlocks(stateOf(doc)), doc).toEqual([]);
  });
});

describe("sheetEdit", () => {
  const doc = `앞\n\n${FENCE}sheet\na | b\n1 | 2\n${FENCE}\n\n뒤`;

  it("returns null when the rows are what the block already holds", () => {
    const state = stateOf(doc);
    const [b] = findSheetBlocks(state);
    expect(sheetEdit(state, b, [["a", "b"], ["1", "2"]])).toBeNull();
    // Padding a cell with spaces doesn't change what's stored either.
    expect(sheetEdit(state, b, [["a ", " b"], ["1", "2"]])).toBeNull();
  });

  it("returns null for unnormalized source text with the same content", () => {
    const state = stateOf(`${FENCE}sheet\na|b\n| 1|2 |\n${FENCE}`);
    const [b] = findSheetBlocks(state);
    expect(sheetEdit(state, b, [["a", "b"], ["1", "2"]])).toBeNull();
  });

  it("changes only the body when a cell changed", () => {
    const state = stateOf(doc);
    const [b] = findSheetBlocks(state);
    const rows = [["a", "b"], ["1", "=A2*3"]];
    const spec = sheetEdit(state, b, rows);
    expect(spec).not.toBeNull();
    const next = state.update(spec!).state;
    const text = next.doc.toString();
    expect(text.startsWith(`앞\n\n${FENCE}sheet\n`)).toBe(true);
    expect(text.endsWith(`\n${FENCE}\n\n뒤`)).toBe(true);
    const nb = findSheetBlocks(stateOf(text))[0];
    expect(parseSheet(text.slice(nb.bodyFrom, nb.bodyTo))).toEqual(rows);
    // Every changed range lies inside the old body.
    state.update(spec!).changes.iterChangedRanges((fromA, toA) => {
      expect(fromA).toBeGreaterThanOrEqual(b.bodyFrom);
      expect(toA).toBeLessThanOrEqual(b.bodyTo);
    });
  });

  it("keeps a cell holding | and an empty edge cell", () => {
    const state = stateOf(doc);
    const [b] = findSheetBlocks(state);
    const rows = [["a", "b"], ["x | y", ""]];
    const next = state.update(sheetEdit(state, b, rows)!).state;
    const nb = findSheetBlocks(stateOf(next.doc.toString()))[0];
    expect(parseSheet(next.sliceDoc(nb.bodyFrom, nb.bodyTo))).toEqual(rows);
  });
});

describe("sheet widget", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view?.dom.remove();
    view = null;
  });

  function mount(doc: string, anchor = 0) {
    const state = EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage }), history(), sheetBlock] });
    ensureSyntaxTree(state, doc.length, 5000);
    view = new EditorView({ state, parent: document.body });
    // The tree was parsed before the view existed; rebuild the decorations with it.
    view.dispatch({ selection: { anchor } });
    return view;
  }
  const cells = (v: EditorView) => [...v.dom.querySelectorAll<HTMLInputElement>("input.cm-sheet-cell")];
  const type = (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const NL = "\n";
  const doc = `글\n\n${FENCE}sheet\n항목 | 금액\n가 | 1,000\n나 | =B2*2\n${FENCE}\n`;

  it("shows the grid with results and a total row; the raw text when the cursor is inside", () => {
    const v = mount(doc);
    const inputs = cells(v);
    expect(inputs.map((i) => i.value)).toEqual(["항목", "금액", "가", "1,000", "나", "2,000"]);
    const total = v.dom.querySelector("tr.cm-sheet-total")!;
    expect(total.textContent).toContain("합계");
    expect(total.textContent).toContain("3,000");
    v.dispatch({ selection: { anchor: doc.indexOf("가") } });
    expect(cells(v)).toHaveLength(0);
    expect(v.dom.querySelectorAll(".cm-sheet-raw").length).toBe(5);
  });

  it("doesn't touch the note on focus and blur without a change, even for unnormalized text", () => {
    const raw = `${FENCE}sheet\n항목|금액\n|가|1000|\n${FENCE}\n\n끝`;
    const v = mount(raw, raw.length);
    const [, , , amount] = cells(v);
    amount.focus();
    type(amount, "1000");
    amount.blur();
    expect(v.state.doc.toString()).toBe(raw);
  });

  it("updates totals while typing, writes on blur, and undo restores the text", () => {
    const v = mount(doc, doc.length);
    const amount = cells(v)[3];
    amount.focus();
    type(amount, "5,000");
    expect(v.state.doc.toString()).toBe(doc); // not written yet
    expect(v.dom.querySelector("tr.cm-sheet-total")!.textContent).toContain("15,000");
    expect(cells(v)[5].value).toBe("10,000"); // the formula cell follows
    amount.blur();
    expect(v.state.doc.toString()).toBe(doc.replace("1,000", "5,000"));
    undo(v);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("shows the formula while focused", () => {
    const v = mount(doc, doc.length);
    const f = cells(v)[5];
    f.focus();
    expect(f.value).toBe("=B2*2");
    f.blur();
    expect(f.value).toBe("2,000");
  });

  it("doesn't write while composing; commits when composition ends after a blur", () => {
    const v = mount(doc, doc.length);
    const name = cells(v)[2];
    name.focus();
    name.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(name, "한");
    name.blur();
    expect(v.state.doc.toString()).toBe(doc);
    name.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(v.state.doc.toString()).toBe(doc.replace("가 |", "한 |"));
  });

  it("adds a row with Enter on the last row, copying the row above's formulas one row down, and deletes a row with its button", () => {
    const v = mount(doc, doc.length);
    const last = cells(v)[4];
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(parseSheet(v.state.doc.toString().split("\n").slice(3, 7).join("\n"))).toEqual([
      ["항목", "금액"],
      ["가", "1,000"],
      ["나", "=B2*2"],
      ["", "=B3*2"],
    ]);
    expect(cells(v)).toHaveLength(8);
    const del = v.dom.querySelectorAll<HTMLButtonElement>("button.cm-sheet-delrow")[3];
    expect(del.title).toBe("삭제하면 수식의 칸 참조가 어긋날 수 있습니다");
    del.click();
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("a new row copies formulas from the row above with their references moved, and nothing else", () => {
    const raw = `${FENCE}sheet${NL}이름 | 수량 | 단가 | 금액${NL}가 | 3 | 1,200 | =B2*C2${NL}${FENCE}${NL}`;
    const v = mount(raw, raw.length);
    const last = cells(v)[7];
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(parseSheet(v.state.doc.toString().split(NL).slice(1, 4).join(NL))).toEqual([
      ["이름", "수량", "단가", "금액"],
      ["가", "3", "1,200", "=B2*C2"],
      ["", "", "", "=B3*C3"],
    ]);
    // And once more, from the new row.
    const again = cells(v)[11];
    again.focus();
    again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(v.state.doc.toString()).toContain("=B4*C4");
  });

  it("a new row under a header-only sheet is empty (the header's cells are not copied)", () => {
    const raw = `${FENCE}sheet${NL}이름 | =A1${NL}${FENCE}${NL}`;
    const v = mount(raw, raw.length);
    const last = cells(v)[1];
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(parseSheet(v.state.doc.toString().split(NL).slice(1, 3).join(NL))).toEqual([["이름", "=A1"], ["", ""]]);
    expect(cells(v)).toHaveLength(4);
    expect(cells(v)[3].value).toBe("");
  });

  it("deleting the last row while one of its cells is focused doesn't throw", () => {
    const v = mount(doc, doc.length);
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onError);
    try {
      cells(v)[4].focus();
      v.dom.querySelectorAll<HTMLButtonElement>("button.cm-sheet-delrow")[2].click();
      expect(errors).toEqual([]);
      expect(v.state.doc.toString()).toBe(`글\n\n${FENCE}sheet\n항목 | 금액\n가 | 1,000\n${FENCE}\n`);
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("a focusout from a cell whose row is gone is a no-op", () => {
    const v = mount(doc, doc.length);
    const input = cells(v)[4];
    input.focus();
    input.dataset.r = "9"; // the row no longer exists
    expect(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))).not.toThrow();
  });

  it("keeps typed text when the grid goes away before the cell is left", async () => {
    const v = mount(doc, doc.length);
    const amount = cells(v)[3];
    amount.focus();
    type(amount, "7");
    // The cursor moves into the block (no blur first): the widget is removed with the text unsaved.
    v.dispatch({ selection: { anchor: doc.indexOf("가") } });
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe(doc.replace("1,000", "7"));
  });

  it("flushSheetEdits writes a focused cell's text synchronously, before the editor is destroyed", () => {
    const v = mount(doc, doc.length);
    const amount = cells(v)[3];
    amount.focus();
    type(amount, "9,000");
    // Editor's save(): flush, read the text, then (on unmount) destroy.
    flushSheetEdits(v);
    const saved = v.state.doc.toString();
    expect(document.activeElement).toBe(amount); // flushing doesn't kick the user out of the cell
    v.destroy();
    expect(saved).toBe(doc.replace("1,000", "9,000"));
  });

  it("flushSheetEdits still writes when the editor is already off the page (unmount cleanup)", () => {
    const two = `${doc}\n${FENCE}sheet\nx | y\n${FENCE}\n`;
    const v = mount(two, 0);
    const amount = cells(v)[3];
    amount.focus();
    type(amount, "8,000");
    v.dom.remove(); // React removes the DOM before running the cleanup that saves
    flushSheetEdits(v);
    expect(v.state.doc.toString()).toBe(two.replace("1,000", "8,000"));
  });

  it("off the page, a block changed in the meantime is not overwritten", async () => {
    const v = mount(doc, doc.length);
    const amount = cells(v)[3];
    amount.focus();
    type(amount, "8,000");
    v.dom.remove();
    // Destroyed: the grid no longer follows the document, and its deferred write is pending.
    v.destroy();
    // The block's text changes before that write runs (e.g. an outside update).
    const at = v.state.doc.toString().indexOf("나 |");
    v.dispatch({ changes: { from: at, to: at + 1, insert: "다" } });
    const changed = v.state.doc.toString();
    flushSheetEdits(v);
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe(changed);
  });

  it("off the page and destroyed, the deferred write still lands when the block is unchanged", async () => {
    const v = mount(doc, doc.length);
    const amount = cells(v)[3];
    amount.focus();
    type(amount, "8,000");
    v.dom.remove();
    v.destroy();
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe(doc.replace("1,000", "8,000"));
  });

  it("flushSheetEdits does nothing when no cell changed", () => {
    const v = mount(doc, doc.length);
    cells(v)[3].focus();
    let dispatched = 0;
    const orig = v.dispatch.bind(v);
    v.dispatch = ((...a: Parameters<typeof orig>) => (dispatched++, orig(...a))) as typeof v.dispatch;
    flushSheetEdits(v);
    expect(dispatched).toBe(0);
  });

  it("writes the cell before an app shortcut (Ctrl/Alt key) runs", () => {
    const v = mount(doc, doc.length);
    const amount = cells(v)[3];
    amount.focus();
    type(amount, "4");
    amount.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    expect(v.state.doc.toString()).toBe(doc.replace("1,000", "4"));
    expect(document.activeElement).toBe(amount);
  });

  it("stays quick for a few hundred rows", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `품목${i} | ${i} | 1,000 | =B${i + 2}*C${i + 2}`);
    const big = `${FENCE}sheet\n항목 | 수량 | 단가 | 금액\n${lines.join("\n")}\n${FENCE}\n`;
    const t0 = performance.now();
    const v = mount(big, big.length);
    const input = cells(v)[5];
    input.focus();
    for (let i = 0; i < 10; i++) type(input, String(i));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(cells(v)).toHaveLength(301 * 4);
  });
});
