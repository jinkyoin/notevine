// 속성 표 보기 (FR-PRP-05)의 칸 값과 정렬. 화면과 상관없는 규칙만 둔다.
import type { FolderTable } from "../api";

export type TableRow = FolderTable["rows"][number];

/** The title column and the modified-date column, around one column per property. */
export const TITLE = "\u0000title";
export const MODIFIED = "\u0000mtime";

export function day(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function cell(row: TableRow, col: string): string {
  if (col === TITLE) return row.title;
  if (col === MODIFIED) return day(row.mtime);
  return row.props[col] ?? "";
}

/** Sorts by a column; empty cells go last either way. Numbers inside text compare as numbers. */
export function sortRows(rows: TableRow[], col: string, desc: boolean): TableRow[] {
  return [...rows].sort((a, b) => {
    if (col === MODIFIED) return desc ? b.mtime - a.mtime : a.mtime - b.mtime;
    const x = cell(a, col);
    const y = cell(b, col);
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    const c = x.localeCompare(y, "ko", { numeric: true });
    return desc ? -c : c;
  });
}
