import { describe, expect, it } from "vitest";
import { evaluateSheet, parseNumber, parseRef, shiftFormulaRows } from "./sheetFormula";

/** Evaluates a one-cell formula placed at B2 of a small sheet (A2 is text). */
function calc(formula: string, extra: string[][] = []) {
  const rows = [["h", "h"], ["t", formula], ...extra];
  return evaluateSheet(rows)[1][1];
}

describe("parseNumber", () => {
  it("parses comma, unit suffix, sign and decimals", () => {
    expect(parseNumber("1,200")).toBe(1200);
    expect(parseNumber("1200원")).toBe(1200);
    expect(parseNumber("-5")).toBe(-5);
    expect(parseNumber("3.5")).toBe(3.5);
  });
  it("returns null for non numbers", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("1,2,3x")).toBeNull();
  });
});

describe("parseRef", () => {
  it("maps A1 notation to 0-based positions", () => {
    expect(parseRef("B2")).toEqual({ row: 1, col: 1 });
    expect(parseRef("A1")).toEqual({ row: 0, col: 0 });
    expect(parseRef("AA10")).toEqual({ row: 9, col: 26 });
    expect(parseRef("2B")).toBeNull();
  });
});

describe("evaluateSheet plain cells", () => {
  it("classifies text, number and empty", () => {
    const r = evaluateSheet([["항목", "금액"], ["a", "1,200"], ["b", ""]]);
    expect(r[0][0]).toEqual({ kind: "text", text: "항목" });
    expect(r[1][1]).toEqual({ kind: "number", value: 1200 });
    expect(r[2][1]).toEqual({ kind: "empty" });
  });
  it("pads ragged rows", () => {
    const r = evaluateSheet([["a", "b", "c"], ["x"]]);
    expect(r[1]).toHaveLength(3);
    expect(r[1][2]).toEqual({ kind: "empty" });
  });
});

describe("arithmetic", () => {
  const num = (v: number) => ({ kind: "number", value: v });
  it("respects precedence and parentheses", () => {
    expect(calc("=1+2*3")).toEqual(num(7));
    expect(calc("=(1+2)*3")).toEqual(num(9));
    expect(calc("=-2*3")).toEqual(num(-6));
    expect(calc("=8/4/2")).toEqual(num(1));
    expect(calc("=2×3÷6")).toEqual(num(1));
    expect(calc("=1.5+1")).toEqual(num(2.5));
    expect(calc("=1,000+1")).toEqual(num(1001));
    expect(calc("=1,000.5*2")).toEqual(num(2001));
    expect(calc("=A3*1,000", [["5", ""]])).toEqual(num(5000));
    expect(calc("=1,00")).toEqual({ kind: "error", error: "#오류" });
  });
  it("rounds floating point noise", () => {
    expect(calc("=0.1+0.2")).toEqual(num(0.3));
  });
});

describe("references", () => {
  it("multiplies cells", () => {
    const r = evaluateSheet([["이름", "수량", "단가", "금액"], ["x", "3", "1,200", "=B2*C2"]]);
    expect(r[1][3]).toEqual({ kind: "number", value: 3600 });
  });
  it("treats empty cells as 0", () => {
    expect(calc("=B3+1", [["", ""]])).toEqual({ kind: "number", value: 1 });
  });
  it("text cell gives #글자", () => {
    expect(calc("=A2+1")).toEqual({ kind: "error", error: "#글자" });
  });
  it("missing cell gives #참조", () => {
    expect(calc("=Z99")).toEqual({ kind: "error", error: "#참조" });
  });
  it("propagates errors from referenced cells", () => {
    const r = evaluateSheet([["h", "h"], ["a", "=1/0"], ["b", "=B2+1"]]);
    expect(r[2][1]).toEqual({ kind: "error", error: "#나누기0" });
  });
});

describe("errors", () => {
  const err = (e: string) => ({ kind: "error", error: e });
  it("reports syntax and arithmetic errors", () => {
    expect(calc("=1/0")).toEqual(err("#나누기0"));
    expect(calc("=1+")).toEqual(err("#오류"));
    expect(calc("=alert(1)")).toEqual(err("#오류"));
  });
  it("detects cycles", () => {
    expect(calc("=B2")).toEqual(err("#순환"));
    const r = evaluateSheet([["h", "h"], ["=B2", "=A2"]]);
    expect(r[1][0]).toEqual(err("#순환"));
    expect(r[1][1]).toEqual(err("#순환"));
  });
  it("rejects absurd input without throwing", () => {
    expect(calc("=" + "(".repeat(10000) + "1" + ")".repeat(10000))).toEqual(err("#오류"));
    expect(calc("=" + "1+".repeat(5000) + "1")).toEqual(err("#오류"));
    expect(calc("=" + "(".repeat(60) + "1" + ")".repeat(60))).toEqual(err("#오류"));
  });
});

describe("performance", () => {
  it("evaluates a 500-row chain quickly", () => {
    const rows: string[][] = [["n", "v"], ["1", "1"]];
    for (let n = 3; n <= 501; n++) rows.push([String(n), `=B${n - 1}+1`]);
    const t = performance.now();
    const r = evaluateSheet(rows);
    expect(performance.now() - t).toBeLessThan(100);
    expect(r[500][1]).toEqual({ kind: "number", value: 500 });
  });
});

describe("shiftFormulaRows", () => {
  it("moves every cell reference down by the given number of rows", () => {
    expect(shiftFormulaRows("=B2*C2", 1)).toBe("=B3*C3");
    expect(shiftFormulaRows("=B2*C2", 2)).toBe("=B4*C4");
    expect(shiftFormulaRows("=A1+AA10", 1)).toBe("=A2+AA11");
  });

  it("keeps the case, spaces, numbers and operators of the formula", () => {
    expect(shiftFormulaRows("= (b2 + 10) / 4", 1)).toBe("= (b3 + 10) / 4");
    expect(shiftFormulaRows("=B2*1,000.5", 1)).toBe("=B3*1,000.5");
  });

  it("leaves anything that is not a formula as it is", () => {
    expect(shiftFormulaRows("1200", 1)).toBe("1200");
    expect(shiftFormulaRows("B2", 1)).toBe("B2");
    expect(shiftFormulaRows("", 1)).toBe("");
  });

  it("keeps a reference that would leave the sheet and shifted results evaluate", () => {
    expect(shiftFormulaRows("=B1", -1)).toBe("=B1");
    const rows = [["이름", "수량", "단가", "금액"], ["x", "3", "1,200", "=B2*C2"], ["y", "2", "500", shiftFormulaRows("=B2*C2", 1)]];
    expect(evaluateSheet(rows)[2][3]).toEqual({ kind: "number", value: 1000 });
  });
});
