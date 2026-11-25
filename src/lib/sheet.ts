// Parsing, serialization and column totals for the sheet block (a markdown-style grid, one row per line, cells split by " | ").
import { evaluateSheet, type Evaluated } from "./sheetFormula";

/** Splits one line on unescaped `|`, resolving `\|` and `\\`. Other backslashes stay literal. */
function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === "\\" && (next === "|" || next === "\\")) {
      cur += next;
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** One line per row, cells separated by `|` (outer pipes optional), cell padding trimmed. Rows keep their own length. */
export function parseSheet(body: string): string[][] {
  if (body.trim() === "") return [];
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => {
      let cells = splitLine(line);
      // Outer pipes leave an empty first/last piece; drop it.
      if (cells.length > 1 && cells[0].trim() === "") cells = cells.slice(1);
      if (cells.length > 1 && cells[cells.length - 1].trim() === "") cells = cells.slice(0, -1);
      return cells.map((c) => c.trim());
    });
}

const escapeCell = (c: string) => c.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

/** Inverse of parseSheet: `a | b | c` per row, no trailing newline. */
export function serializeSheet(rows: string[][]): string {
  return rows
    .map((raw) => {
      // Trim first so the outer-pipe test below matches parseSheet's `.trim() === ""` test.
      const r = raw.map((c) => c.trim());
      const line = r.map(escapeCell).join(" | ");
      // An empty edge cell would be read back as an outer pipe, so such rows get explicit outer pipes.
      return r.length > 1 && (r[0] === "" || r[r.length - 1] === "") ? `| ${line} |` : line;
    })
    .join("\n");
}

export type Total = { kind: "none" } | { kind: "sum"; value: number } | { kind: "error" };

/**
 * One entry per column. The first column is the name column (always none). From the second column on, a column
 * is summed when its data cells (header row excluded) are all numbers or empty with at least one number;
 * any error cell makes it an error. Returns null when no column has a sum or error.
 */
export function computeTotals(rows: string[][]): Total[] | null {
  const grid = evaluateSheet(rows);
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const totals: Total[] = [];
  for (let c = 0; c < width; c++) {
    totals.push(c === 0 ? { kind: "none" } : columnTotal(grid, c));
  }
  return totals.some((t) => t.kind !== "none") ? totals : null;
}

function columnTotal(grid: Evaluated[][], col: number): Total {
  let sum = 0;
  let numbers = 0;
  let hasText = false;
  for (let r = 1; r < grid.length; r++) {
    const cell = grid[r][col];
    if (cell.kind === "error") return { kind: "error" };
    if (cell.kind === "text") hasText = true;
    else if (cell.kind === "number") {
      sum += cell.value;
      numbers++;
    }
  }
  if (hasText || numbers === 0) return { kind: "none" };
  return { kind: "sum", value: Number(sum.toFixed(10)) };
}

/** 1234567.5 → "1,234,567.5": thousands separators, up to 10 decimals, float noise removed. */
export function formatNumber(n: number): string {
  return Number(n.toFixed(10)).toLocaleString("en-US", { maximumFractionDigits: 10 });
}

export function displayCell(e: Evaluated): string {
  switch (e.kind) {
    case "number":
      return formatNumber(e.value);
    case "error":
      return e.error;
    case "text":
      return e.text;
    default:
      return "";
  }
}
