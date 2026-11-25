// Formula and number evaluator for the sheet block (a markdown grid whose cells may hold =B2*C2).
// Hand-written tokenizer + recursive descent parser; no eval/Function.

export type SheetError = "#오류" | "#나누기0" | "#참조" | "#순환" | "#글자";
export type Evaluated =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "number"; value: number }
  | { kind: "error"; error: SheetError };

const MAX_FORMULA_LENGTH = 1000;
const MAX_DEPTH = 50;

const NUMBER_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/** "1,200" · "1200원" · "-5" · "3.5" → number. Anything else (including blank) → null. */
export function parseNumber(text: string): number | null {
  const s = text.trim().replace(/\s*원$/, "");
  if (!NUMBER_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** "B2" → { row: 1, col: 1 } (0-based, header row = 0); null if not a reference. */
export function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]) - 1;
  if (row < 0) return null;
  return { row, col: col - 1 };
}

/**
 * A formula copied `delta` rows down: every cell reference moves with it (B2 → B3), like
 * a fill in a spreadsheet. Text that is not a formula, and a reference that would leave the
 * sheet (row < 1), stay as they are. Anything but a reference (numbers, operators, spaces)
 * is kept exactly.
 */
export function shiftFormulaRows(formula: string, delta: number): string {
  if (!formula.startsWith("=")) return formula;
  return formula.replace(/([A-Za-z]+)(\d+)/g, (whole, col: string, row: string) => {
    const next = Number(row) + delta;
    return next >= 1 ? `${col}${next}` : whole;
  });
}

/** Thrown internally; carries the error shown in the cell. */
class SheetFail extends Error {
  constructor(readonly error: SheetError) {
    super(error);
  }
}

type Token =
  | { t: "num"; v: number }
  | { t: "ref"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const rest = src.slice(i);
      const m = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])/.exec(rest) ?? /^\d*\.?\d+|^\d+\.?/.exec(rest);
      if (!m) throw new SheetFail("#오류");
      out.push({ t: "num", v: Number(m[0].replace(/,/g, "")) });
      i += m[0].length;
    } else if (/[A-Za-z]/.test(ch)) {
      const m = /^[A-Za-z]+\d+/.exec(src.slice(i));
      if (!m) throw new SheetFail("#오류");
      out.push({ t: "ref", v: m[0] });
      i += m[0].length;
    } else if ("+-*/×÷()".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
    } else {
      throw new SheetFail("#오류");
    }
  }
  return out;
}

/** Evaluates every cell of rows[r][c] (row 0 = header). Same shape as the input, ragged rows padded to the widest row. Each cell is computed once. */
export function evaluateSheet(rows: string[][]): Evaluated[][] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const grid = rows.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? ""));
  const memo: (Evaluated | "visiting" | undefined)[][] = grid.map((r) => r.map(() => undefined));

  const cellValue = (row: number, col: number): Evaluated => {
    const cached = memo[row][col];
    if (cached === "visiting") return { kind: "error", error: "#순환" };
    if (cached) return cached;
    memo[row][col] = "visiting";
    const result = compute(grid[row][col]);
    memo[row][col] = result;
    return result;
  };

  const compute = (raw: string): Evaluated => {
    const text = raw.trim();
    if (text === "") return { kind: "empty" };
    if (text.startsWith("=")) {
      try {
        return { kind: "number", value: evalFormula(text.slice(1)) };
      } catch (e) {
        return { kind: "error", error: e instanceof SheetFail ? e.error : "#오류" };
      }
    }
    const n = parseNumber(text);
    return n === null ? { kind: "text", text: raw } : { kind: "number", value: n };
  };

  const refValue = (ref: string): number => {
    const p = parseRef(ref);
    if (!p || p.row >= grid.length || p.col >= width) throw new SheetFail("#참조");
    const v = cellValue(p.row, p.col);
    if (v.kind === "error") throw new SheetFail(v.error);
    if (v.kind === "text") throw new SheetFail("#글자");
    return v.kind === "number" ? v.value : 0;
  };

  const evalFormula = (src: string): number => {
    if (src.length > MAX_FORMULA_LENGTH) throw new SheetFail("#오류");
    const toks = tokenize(src);
    let pos = 0;
    const peekOp = () => {
      const k = toks[pos];
      return k && k.t === "op" ? k.v : null;
    };

    // expr := term (('+'|'-') term)*
    const expr = (depth: number): number => {
      let v = term(depth);
      for (let op = peekOp(); op === "+" || op === "-"; op = peekOp()) {
        pos++;
        const r = term(depth);
        v = op === "+" ? v + r : v - r;
      }
      return v;
    };
    // term := factor (('*'|'/'|'×'|'÷') factor)*
    const term = (depth: number): number => {
      let v = factor(depth);
      for (let op = peekOp(); op === "*" || op === "/" || op === "×" || op === "÷"; op = peekOp()) {
        pos++;
        const r = factor(depth);
        if (op === "*" || op === "×") v *= r;
        else {
          if (r === 0) throw new SheetFail("#나누기0");
          v /= r;
        }
      }
      return v;
    };
    // factor := ('-'|'+') factor | number | ref | '(' expr ')'
    const factor = (depth: number): number => {
      if (depth > MAX_DEPTH) throw new SheetFail("#오류");
      const k = toks[pos++];
      if (!k) throw new SheetFail("#오류");
      if (k.t === "num") return k.v;
      if (k.t === "ref") return refValue(k.v);
      if (k.v === "-") return -factor(depth + 1);
      if (k.v === "+") return factor(depth + 1);
      if (k.v === "(") {
        const v = expr(depth + 1);
        if (toks[pos++]?.v !== ")") throw new SheetFail("#오류");
        return v;
      }
      throw new SheetFail("#오류");
    };

    const value = expr(0);
    if (pos !== toks.length) throw new SheetFail("#오류");
    if (!Number.isFinite(value)) throw new SheetFail("#오류");
    const rounded = Number(value.toFixed(10));
    if (!Number.isFinite(rounded)) throw new SheetFail("#오류");
    return rounded;
  };

  return grid.map((r, ri) => r.map((_, ci) => cellValue(ri, ci)));
}
