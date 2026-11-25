import { describe, expect, it } from "vitest";
import { evaluateSheet } from "./sheetFormula";
import { computeTotals, displayCell, formatNumber, parseSheet, serializeSheet } from "./sheet";

const QUOTE = "항목 | 수량 | 단가\n인건비 | 3 | 1200000\n장비 | 2 | 500000";

describe("parseSheet / serializeSheet", () => {
  it("round-trips a plain table", () => {
    expect(parseSheet(QUOTE)).toEqual([
      ["항목", "수량", "단가"],
      ["인건비", "3", "1200000"],
      ["장비", "2", "500000"],
    ]);
    expect(serializeSheet(parseSheet(QUOTE))).toBe(QUOTE);
  });

  it("accepts outer pipes and normalizes them away", () => {
    const once = serializeSheet(parseSheet("| a | b |\n| 1 | 2 |"));
    expect(once).toBe("a | b\n1 | 2");
    expect(serializeSheet(parseSheet(once))).toBe(once);
  });

  it("escapes pipes and backslashes", () => {
    const rows = [["a|b", "c\\d"]];
    const text = serializeSheet(rows);
    expect(text).toBe("a\\|b | c\\\\d");
    expect(parseSheet(text)).toEqual(rows);
  });

  it("keeps ragged rows and empty cells as they are", () => {
    const rows = parseSheet("가 | 나 | 다\n라\n마 |  | 바");
    expect(rows).toEqual([["가", "나", "다"], ["라"], ["마", "", "바"]]);
    expect(serializeSheet(rows)).toBe("가 | 나 | 다\n라\n마 |  | 바");
  });

  it("keeps empty cells at either edge through a round trip", () => {
    const rows = [["", "b"], ["a", ""], ["", ""]];
    expect(parseSheet(serializeSheet(rows))).toEqual(rows);
  });

  it("trims whitespace-only edge cells so the outer-pipe rule matches parseSheet", () => {
    const rows = [[" ", "100", "200"], ["a", " "], [" ", "금액"]];
    const expected = [["", "100", "200"], ["a", ""], ["", "금액"]];
    const text = serializeSheet(rows);
    expect(parseSheet(text)).toEqual(expected);
    expect(serializeSheet(parseSheet(text))).toBe(text);
    expect(serializeSheet(parseSheet(serializeSheet(parseSheet(text))))).toBe(text);
  });

  it("returns no rows for an empty body", () => {
    expect(parseSheet("")).toEqual([]);
  });
});

describe("computeTotals", () => {
  const rows = [
    ["항목", "수량", "단가", "금액"],
    ["인건비", "3", "1200000", "=B2*C2"],
    ["장비", "2", "500000", "=B3*C3"],
  ];

  it("sums numeric columns and skips the name column", () => {
    expect(computeTotals(rows)).toEqual([
      { kind: "none" },
      { kind: "sum", value: 5 },
      { kind: "sum", value: 1700000 },
      { kind: "sum", value: 4600000 },
    ]);
  });

  it("never sums a numeric first column", () => {
    const t = computeTotals([["번호", "값"], ["1", "10"], ["2", "20"]]);
    expect(t).toEqual([{ kind: "none" }, { kind: "sum", value: 30 }]);
  });

  it("gives none for mixed text, all-empty and returns null with no sum", () => {
    const t = computeTotals([["a", "b", "c", "d"], ["x", "1", "", "5"], ["y", "글", "", "6"]]);
    expect(t).toEqual([{ kind: "none" }, { kind: "none" }, { kind: "none" }, { kind: "sum", value: 11 }]);
    expect(computeTotals([["a", "b"], ["x", "글"], ["y", ""]])).toBeNull();
    expect(computeTotals([["번호", "b"], ["1", ""]])).toBeNull();
  });

  it("marks a column with an error cell as error", () => {
    const t = computeTotals([["a", "b"], ["x", "1"], ["y", "=1/0"]]);
    expect(t).toEqual([{ kind: "none" }, { kind: "error" }]);
  });

  it("excludes the header row and treats missing cells as empty", () => {
    const t = computeTotals([["a", "7"], ["x", "1"], ["y"]]);
    expect(t).toEqual([{ kind: "none" }, { kind: "sum", value: 1 }]);
    expect(computeTotals([])).toBeNull();
    expect(computeTotals([["a", "b"]])).toBeNull();
  });
});

describe("formatNumber / displayCell", () => {
  it("formats with thousands separators", () => {
    expect(formatNumber(1234567.5)).toBe("1,234,567.5");
    expect(formatNumber(-1200)).toBe("-1,200");
    expect(formatNumber(0)).toBe("0");
  });

  it("hides floating point noise", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    const t = computeTotals([["a", "b"], ["x", "0.1"], ["y", "0.2"]]);
    expect(t && t[1].kind === "sum" && formatNumber(t[1].value)).toBe("0.3");
  });

  it("displays each evaluated kind", () => {
    const g = evaluateSheet([["글", "1200", "", "=1/0"]]);
    expect(g[0].map(displayCell)).toEqual(["글", "1,200", "", "#나누기0"]);
  });
});
