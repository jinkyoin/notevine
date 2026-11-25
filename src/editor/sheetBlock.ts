// SCR-04, FR-EDT-12: a top-level ```sheet block shows as an editable grid with a computed total row.
// When the cursor is inside the block the raw text is shown for editing (same pattern as frontmatterFold).
// Cells write to the note only when a cell is left (blur, Enter, Tab) and its content actually changed;
// while typing (and never during IME composition) only the grid's own results and totals update.
import { type EditorState, type Extension, type Range, StateField, type TransactionSpec } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { computeTotals, displayCell, formatNumber, parseSheet, serializeSheet } from "../lib/sheet";
import { evaluateSheet, shiftFormulaRows, type Evaluated } from "../lib/sheetFormula";

import { tx } from "../i18n";

export type SheetBlockRange = { from: number; to: number; bodyFrom: number; bodyTo: number };

/** Top-level (not in a list or quote) ```sheet fences with a closing fence and some text. */
export function findSheetBlocks(state: EditorState): SheetBlockRange[] {
  const out: SheetBlockRange[] = [];
  // Only the document's direct children: cheap even for long notes.
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "FencedCode") continue;
    const open = node.firstChild;
    const close = node.lastChild;
    const info = node.getChild("CodeInfo");
    if (!open || !close || open === close || open.name !== "CodeMark" || close.name !== "CodeMark") continue;
    if (state.sliceDoc(open.from, open.to) !== "```" || !info || state.sliceDoc(info.from, info.to) !== "sheet") continue;
    const openLine = state.doc.lineAt(open.from);
    const closeLine = state.doc.lineAt(close.from);
    if (closeLine.number <= openLine.number) continue;
    const bodyFrom = openLine.to + 1;
    const bodyTo = Math.max(bodyFrom, closeLine.from - 1);
    if (state.sliceDoc(bodyFrom, bodyTo).trim() === "") continue;
    out.push({ from: openLine.from, to: closeLine.to, bodyFrom, bodyTo });
  }
  return out;
}

const sameRows = (a: string[][], b: string[][]) =>
  a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((c, j) => c === b[i][j]));

/** The change writing `rows` into the block body, or null when the body already holds that content. */
export function sheetEdit(state: EditorState, block: SheetBlockRange, rows: string[][]): TransactionSpec | null {
  const insert = serializeSheet(rows);
  // Compare parsed content, not text: unnormalized source with the same cells is left alone.
  if (sameRows(parseSheet(state.sliceDoc(block.bodyFrom, block.bodyTo)), parseSheet(insert))) return null;
  return { changes: { from: block.bodyFrom, to: block.bodyTo, insert }, userEvent: "input.sheet" };
}

/** 0 → A, 25 → Z, 26 → AA. */
function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const isFormula = (raw: string) => raw.trim().startsWith("=");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

type Focus = { r: number; c: number; start: number | null; end: number | null };

/** The grid's DOM and the working copy of its rows. One per widget DOM. */
class SheetGrid {
  readonly dom = el("div", "cm-sheet");
  /** Working rows; ragged like the source (a row only grows when a cell past its end gets text). */
  private rows: string[][] = [];
  /** Each row's length as read (or as created); trailing empty cells beyond it aren't written. */
  private baseLen: number[] = [];
  /** The rows as last read from the document. */
  private base: string[][] = [];
  private inputs: HTMLInputElement[][] = [];
  private table = el("table", "cm-sheet-grid");
  private dirty = false;
  private composing = false;
  private commitAfterComposition = false;
  private lastFrom: number;

  constructor(
    private readonly view: EditorView,
    rows: string[][],
    from: number,
  ) {
    this.lastFrom = from;
    this.load(rows);
    const bar = el("div", "cm-sheet-bar");
    const raw = el("button", "cm-sheet-btn", tx("원문 편집"));
    raw.type = "button";
    raw.dataset.act = "raw";
    bar.append(raw);
    const add = el("button", "cm-sheet-btn cm-sheet-add", "+");
    add.type = "button";
    add.dataset.act = "addrow";
    add.title = tx("행 추가");
    this.dom.append(bar, this.table, add);
    this.listen();
    this.render();
    let set = liveGrids.get(view);
    if (!set) liveGrids.set(view, (set = new Set()));
    set.add(this);
  }

  private load(rows: string[][]) {
    this.base = rows;
    this.rows = rows.map((r) => r.slice());
    this.baseLen = rows.map((r) => r.length);
    this.dirty = false;
  }

  private width() {
    return this.rows.reduce((w, r) => Math.max(w, r.length), 1);
  }

  /** Rows to store: trailing empty cells a row only got from the grid's padding are dropped. */
  private output(): string[][] {
    return this.rows.map((row, i) => {
      const out = row.slice();
      while (out.length > this.baseLen[i] && out[out.length - 1] === "") out.pop();
      return out;
    });
  }

  private setCell(r: number, c: number, value: string) {
    const row = this.rows[r];
    if (c >= row.length) {
      if (value === "") return;
      while (row.length < c) row.push("");
      row.push(value);
    } else row[c] = value;
    this.dirty = true;
  }

  private display(r: number, c: number, ev: Evaluated[][]): string {
    const raw = this.rows[r]?.[c] ?? "";
    return isFormula(raw) ? displayCell(ev[r][c]) : raw;
  }

  /** Rebuilds the table, then puts the focus (and caret) back where it was asked. */
  private render(focus?: Focus) {
    const width = this.width();
    const ev = evaluateSheet(this.rows);
    const delTitle = tx("삭제하면 수식의 칸 참조가 어긋날 수 있습니다");
    const head = el("tr");
    head.append(el("th", "cm-sheet-corner"));
    for (let c = 0; c < width; c++) {
      const th = el("th", "cm-sheet-col", colName(c));
      if (width > 1) th.append(this.button("×", "delcol", delTitle, c));
      head.append(th);
    }
    const addCol = el("th", "cm-sheet-corner");
    addCol.append(this.button("+", "addcol", tx("열 추가")));
    head.append(addCol);
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    this.inputs = this.rows.map((_, r) => {
      const tr = el("tr", r === 0 ? "cm-sheet-head" : undefined);
      const num = el("th", "cm-sheet-rownum", String(r + 1));
      if (this.rows.length > 1) num.append(this.button("×", "delrow", delTitle, r));
      tr.append(num);
      const cells: HTMLInputElement[] = [];
      for (let c = 0; c < width; c++) {
        const input = el("input", "cm-sheet-cell");
        input.type = "text";
        input.spellcheck = false;
        input.dataset.r = String(r);
        input.dataset.c = String(c);
        input.value = this.display(r, c, ev);
        this.mark(input, r, c, ev);
        const td = el("td");
        td.append(input);
        tr.append(td);
        cells.push(input);
      }
      tbody.append(tr);
      return cells;
    });
    tbody.append(this.totalRow(width));
    this.table.replaceChildren(thead, tbody);
    if (focus) this.focusCell(focus.r, focus.c, focus.start, focus.end);
  }

  private button(text: string, act: string, title: string, index?: number) {
    const b = el("button", `cm-sheet-btn cm-sheet-${act}`, text);
    b.type = "button";
    b.title = title;
    b.dataset.act = act;
    if (index !== undefined) b.dataset.i = String(index);
    return b;
  }

  private mark(input: HTMLInputElement, r: number, c: number, ev: Evaluated[][]) {
    const e = ev[r][c];
    input.classList.toggle("err", e.kind === "error");
    input.classList.toggle("num", r > 0 && e.kind === "number");
  }

  private totalRow(width: number) {
    const tr = el("tr", "cm-sheet-total");
    const totals = computeTotals(this.rows);
    if (!totals) {
      tr.hidden = true;
      return tr;
    }
    tr.append(el("th"));
    for (let c = 0; c < width; c++) {
      const t = totals[c] ?? { kind: "none" };
      const text = c === 0 ? tx("합계") : t.kind === "sum" ? formatNumber(t.value) : t.kind === "error" ? "#오류" : "";
      tr.append(el("td", t.kind === "error" ? "err" : t.kind === "sum" ? "num" : undefined, text));
    }
    return tr;
  }

  /** While typing: recompute results and totals on screen only (the focused cell keeps its text). */
  private refresh() {
    const ev = evaluateSheet(this.rows);
    const active = document.activeElement;
    this.inputs.forEach((cells, r) =>
      cells.forEach((input, c) => {
        if (input !== active) {
          const v = this.display(r, c, ev);
          if (input.value !== v) input.value = v;
        }
        this.mark(input, r, c, ev);
      }),
    );
    const old = this.table.querySelector("tr.cm-sheet-total");
    old?.replaceWith(this.totalRow(this.width()));
  }

  private focusCell(r: number, c: number, start: number | null = null, end: number | null = null) {
    const input = this.inputs[r]?.[c];
    if (!input) return;
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(start ?? len, end ?? len);
  }

  /** The block's start in the document, while the widget is on screen. */
  private locate(): number | null {
    if (!this.dom.isConnected) return null;
    try {
      this.lastFrom = this.view.posAtDOM(this.dom);
      return this.lastFrom;
    } catch {
      return null;
    }
  }

  private blockAt(state: EditorState, pos: number) {
    return findSheetBlocks(state).find((b) => b.from <= pos && pos <= b.to) ?? null;
  }

  /**
   * Off the page (the editor is being closed, the widget was removed) the grid's position is unknown:
   * take the block nearest to where it last was, and only if it still holds the rows the grid was built
   * from, so a block changed in the meantime is never overwritten.
   */
  private ownBlock(state: EditorState, head?: number): SheetBlockRange | null {
    const near = this.lastFrom;
    const mine = findSheetBlocks(state).filter((b) => sameRows(parseSheet(state.sliceDoc(b.bodyFrom, b.bodyTo)), this.base));
    if (head !== undefined) {
      const at = mine.find((b) => b.from <= head && head <= b.to);
      if (at) return at;
    }
    return mine.reduce<SheetBlockRange | null>((best, b) => (!best || Math.abs(b.from - near) < Math.abs(best.from - near) ? b : best), null);
  }

  /** Writes the rows to the note if their content changed. Never while composing. */
  commit() {
    if (this.composing || !this.dirty) return;
    const pos = this.locate();
    const block = pos !== null ? this.blockAt(this.view.state, pos) : this.ownBlock(this.view.state);
    if (!block) return;
    this.dirty = false;
    const spec = sheetEdit(this.view.state, block, this.output());
    if (spec) this.view.dispatch(spec);
  }

  /** The document changed under the widget (our own commit, undo, an outside edit). */
  sync(rows: string[][]) {
    if (sameRows(parseSheet(serializeSheet(this.output())), rows)) {
      // Our own commit: the grid already shows this; keep the DOM (and the focus) as it is.
      this.base = rows;
      return;
    }
    const active = document.activeElement;
    let focus: Focus | undefined;
    if (active instanceof HTMLInputElement && this.dom.contains(active)) {
      focus = { r: Number(active.dataset.r), c: Number(active.dataset.c), start: active.selectionStart, end: active.selectionEnd };
    }
    this.load(rows);
    this.render(focus);
  }

  /** The widget left the screen (cursor moved into the block, scrolled away): keep typed text. */
  detach() {
    liveGrids.get(this.view)?.delete(this);
    if (!this.dirty) return;
    setTimeout(() => {
      // A save (flushSheetEdits) may have written it already; composition ended by now.
      if (!this.dirty) return;
      const state = this.view.state;
      const block = this.ownBlock(state, state.selection.main.head);
      if (!block) return;
      this.dirty = false;
      const spec = sheetEdit(state, block, this.output());
      if (spec) this.view.dispatch(spec);
    });
  }

  /** Structural edits (add/delete row or column) write at once and redraw. */
  private change(mutate: () => void, focus?: { r: number; c: number }) {
    this.commit();
    mutate();
    this.dirty = true;
    this.commit();
    this.render(focus && { ...focus, start: null, end: null });
  }

  private addRow(focusCol: number) {
    const width = this.width();
    this.change(
      () => {
        // Formulas of the row above come along, one row down (`=B2*C2` → `=B3*C3`); the
        // header row is not a template, and values are never copied.
        const above = this.rows.length > 1 ? this.rows[this.rows.length - 1] : null;
        const fill = (c: number) => {
          const cell = (above?.[c] ?? "").trim();
          return cell.startsWith("=") ? shiftFormulaRows(cell, 1) : "";
        };
        this.rows.push(Array.from({ length: width }, (_, c) => fill(c)));
        this.baseLen.push(width);
      },
      { r: this.rows.length, c: focusCol },
    );
  }

  private act(act: string, i: number) {
    if (act === "raw") {
      this.commit();
      const pos = this.locate();
      if (pos === null) return;
      const at = this.view.state.doc.lineAt(pos).to;
      this.view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      this.view.focus();
    } else if (act === "addrow") {
      this.addRow(0);
    } else if (act === "addcol") {
      const width = this.width() + 1;
      this.change(() => {
        for (const row of this.rows) while (row.length < width) row.push("");
        this.baseLen = this.rows.map(() => width);
      });
    } else if (act === "delrow" && this.rows.length > 1) {
      this.change(() => {
        this.rows.splice(i, 1);
        this.baseLen.splice(i, 1);
      });
    } else if (act === "delcol" && this.width() > 1) {
      this.change(() => {
        this.rows.forEach((row, r) => {
          if (i < row.length) row.splice(i, 1);
          if (this.baseLen[r] > i) this.baseLen[r]--;
        });
      });
    }
  }

  private onKey(e: KeyboardEvent, r: number, c: number) {
    if (e.isComposing || this.composing) return;
    if (e.altKey || e.ctrlKey || e.metaKey) {
      // App shortcuts (Ctrl+S, Ctrl+W…) act on the note text: write the cell first. No-op when unchanged.
      this.commit();
      return;
    }
    const last = this.rows.length - 1;
    const width = this.width();
    if (e.key === "Tab") {
      e.preventDefault();
      this.commit();
      if (e.shiftKey) {
        if (c > 0) this.focusCell(r, c - 1);
        else if (r > 0) this.focusCell(r - 1, width - 1);
      } else if (c + 1 < width) this.focusCell(r, c + 1);
      else if (r < last) this.focusCell(r + 1, 0);
      else this.addRow(0);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.commit();
      if (r < last) this.focusCell(r + 1, c);
      else this.addRow(c);
    } else if (e.key === "ArrowUp" && r > 0) {
      e.preventDefault();
      this.focusCell(r - 1, c);
    } else if (e.key === "ArrowDown" && r < last) {
      e.preventDefault();
      this.focusCell(r + 1, c);
    }
  }

  private listen() {
    const cellOf = (t: EventTarget | null) =>
      t instanceof HTMLInputElement && t.dataset.r !== undefined ? { input: t, r: Number(t.dataset.r), c: Number(t.dataset.c) } : null;
    const d = this.dom;
    d.addEventListener("focusin", (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      this.locate();
      const raw = this.rows[cell.r]?.[cell.c] ?? "";
      if (cell.input.value !== raw) cell.input.value = raw; // a formula shows itself while focused
    });
    d.addEventListener("focusout", (e) => {
      const cell = cellOf(e.target);
      if (!cell || !this.dom.contains(cell.input) || !this.rows[cell.r]) return; // the row was deleted under the focus
      cell.input.value = this.display(cell.r, cell.c, evaluateSheet(this.rows));
      if (this.composing) this.commitAfterComposition = true;
      // Removed from the page mid-update: detach() saves the text instead.
      else if (this.dom.isConnected) this.commit();
    });
    d.addEventListener("input", (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      this.setCell(cell.r, cell.c, cell.input.value);
      this.refresh();
    });
    d.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    d.addEventListener("compositionend", (e) => {
      this.composing = false;
      const cell = cellOf(e.target);
      if (cell) {
        this.setCell(cell.r, cell.c, cell.input.value);
        this.refresh();
      }
      if (this.commitAfterComposition) {
        this.commitAfterComposition = false;
        if (this.dom.isConnected) this.commit();
      }
    });
    d.addEventListener("keydown", (e) => {
      const cell = cellOf(e.target);
      if (cell) this.onKey(e, cell.r, cell.c);
    });
    // Buttons: keep the focus in the cell being edited; act on click.
    d.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    });
    d.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b?.dataset.act) this.act(b.dataset.act, Number(b.dataset.i ?? -1));
    });
  }
}

const grids = new WeakMap<HTMLElement, SheetGrid>();

/** Grids on screen per editor, so a save can collect text typed into a cell not yet left. */
const liveGrids = new WeakMap<EditorView, Set<SheetGrid>>();

/**
 * Writes every grid's uncommitted cell text into the document (synchronously, focus kept).
 * Call before reading the text to save it. Skips a grid in the middle of IME composition.
 */
export function flushSheetEdits(view: EditorView) {
  for (const grid of [...(liveGrids.get(view) ?? [])]) grid.commit();
}

class SheetWidget extends WidgetType {
  constructor(
    readonly body: string,
    readonly from: number,
  ) {
    super();
  }
  // Position isn't compared: typing above the block must not redraw the grid.
  eq(o: SheetWidget) {
    return o.body === this.body;
  }
  toDOM(view: EditorView) {
    const grid = new SheetGrid(view, parseSheet(this.body), this.from);
    grids.set(grid.dom, grid);
    return grid.dom;
  }
  updateDOM(dom: HTMLElement) {
    const grid = grids.get(dom);
    if (!grid) return false;
    grid.sync(parseSheet(this.body));
    return true;
  }
  destroy(dom: HTMLElement) {
    grids.get(dom)?.detach();
  }
  get estimatedHeight() {
    return (this.body.split("\n").length + 3) * 28;
  }
  // Keys, clicks and IME events in the grid belong to its inputs, not the editor.
  ignoreEvent() {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const sel = state.selection.main;
  for (const b of findSheetBlocks(state)) {
    if (sel.from <= b.to && sel.to >= b.from) {
      // Editing the raw text: mark its lines, no widget.
      for (let pos = b.from; pos <= b.to; ) {
        const line = state.doc.lineAt(pos);
        out.push(Decoration.line({ class: "cm-sheet-raw" }).range(line.from));
        pos = line.to + 1;
      }
    } else {
      const widget = new SheetWidget(state.sliceDoc(b.bodyFrom, b.bodyTo), b.from);
      out.push(Decoration.replace({ widget, block: true }).range(b.from, b.to));
    }
  }
  return Decoration.set(out);
}

export const sheetBlock: Extension = StateField.define<DecorationSet>({
  create: build,
  update(deco, tr) {
    // Rebuilding only walks the document's top-level nodes; unchanged grids are kept (eq on the body).
    if (!tr.docChanged && !tr.selection && syntaxTree(tr.startState) === syntaxTree(tr.state)) return deco;
    return build(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});
