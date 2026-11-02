// 폴더 칸반·캘린더 보기 (FR-PRS-08)의 묶음·날짜 규칙. 화면과 상관없는 규칙만 둔다.
import type { FolderTable } from "../api";
import { day, MODIFIED, type TableRow } from "./folderTable";

/** The board column for notes without the property. */
export const NONE = "";
/** Calendar field: a note named after its date, as journals are ("2026-11-02"). */
export const BY_NAME = "\u0000name";

export interface BoardColumn {
  value: string;
  rows: TableRow[];
}

/**
 * Groups notes into columns by one property: the `preferred` values first, in that
 * order and even when empty, then other values by how many notes have them, then
 * the notes without it.
 */
export function boardColumns(rows: TableRow[], key: string, preferred: string[]): BoardColumn[] {
  const groups = new Map<string, TableRow[]>(preferred.map((v) => [v, []]));
  const none: TableRow[] = [];
  for (const r of rows) {
    const v = r.props[key]?.trim();
    if (!v) none.push(r);
    else groups.set(v, [...(groups.get(v) ?? []), r]);
  }
  const rest = [...groups].filter(([v]) => !preferred.includes(v)).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "ko"));
  const cols = [...preferred.map((v) => ({ value: v, rows: groups.get(v)! })), ...rest.map(([value, rows]) => ({ value, rows }))];
  if (none.length) cols.push({ value: NONE, rows: none });
  return cols;
}

/** Properties worth grouping by: ones with few distinct short values, `status` first. */
export function groupKeys(table: FolderTable): string[] {
  return table.columns.filter((key) => {
    const values = new Set(table.rows.map((r) => r.props[key]).filter(Boolean));
    return key === "status" || (values.size > 0 && values.size <= 12 && [...values].every((v) => v.length <= 30));
  });
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function validDate(s: string | undefined): string | null {
  const m = s?.trim().match(DATE);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? m[0] : null;
}

/** The day (YYYY-MM-DD) a note sits on in the calendar, by the chosen field. */
export function noteDate(row: TableRow, field: string): string | null {
  if (field === MODIFIED) return day(row.mtime);
  if (field === BY_NAME) return validDate(row.title);
  return validDate(row.props[field]);
}

/** Fields a calendar can use: date properties (most used first), date-named notes, modified date. */
export function dateFields(table: FolderTable): string[] {
  const props = table.columns.filter((key) => table.rows.some((r) => validDate(r.props[key])));
  const named = table.rows.some((r) => validDate(r.title));
  return [...props, ...(named ? [BY_NAME] : []), MODIFIED];
}

/** The 6 weeks (Sunday first) shown for a month; `month` is 0-based. */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => day(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).getTime()));
}
