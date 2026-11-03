// 속성 표 보기 (FR-PRP-05): 폴더 안 노트를 속성 열로 된 표로 본다. 열 제목으로 정렬, 행을 누르면 노트가 열린다.
import { useMemo, useState } from "react";
import type { FolderTable as Table } from "../api";
import { useApp } from "../store";
import { cell, MODIFIED, sortRows, TITLE } from "../lib/folderTable";
import { parentPath } from "../lib/tree";
import { openProps } from "./TabBar";

import { tx } from "../i18n";
/** Subfolder a note sits in, relative to `folder`; left out for a project's own overview note ("이사/이사.md"). */
export function subFolder(folder: string, path: string, title: string): string {
  const sub = parentPath(path).slice(folder ? folder.length + 1 : 0);
  return sub === title || sub.endsWith("/" + title) ? sub.slice(0, -title.length).replace(/\/$/, "") : sub;
}

export function FolderTable({ folder, table }: { folder: string; table: Table }) {
  const [sort, setSort] = useState<{ col: string; desc: boolean }>({
    col: TITLE,
    desc: false,
  });
  const rows = useMemo(() => sortRows(table.rows, sort.col, sort.desc), [table, sort]);
  const cols = [TITLE, ...table.columns, MODIFIED];
  const label = (col: string) => (col === TITLE ? tx("제목") : col === MODIFIED ? tx("수정일") : col);
  const { openNote } = useApp.getState();

  return (
    <div className="folder-table-scroll">
      <table>
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col} aria-sort={sort.col === col ? (sort.desc ? "descending" : "ascending") : undefined}>
                <button
                  onClick={() =>
                    setSort((s) => ({
                      col,
                      desc: s.col === col ? !s.desc : col === MODIFIED,
                    }))
                  }
                  title={tx("눌러서 정렬")}
                >
                  {label(col)}
                  {sort.col === col && <span className="sort-mark">{sort.desc ? " ▼" : " ▲"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sub = subFolder(folder, r.path, r.title);
            return (
              <tr key={r.path} title={r.path} {...openProps((o) => openNote(r.path, undefined, undefined, o))}>
                {cols.map((col) => (
                  <td key={col} className={col === TITLE ? "title" : undefined}>
                    {cell(r, col)}
                    {col === TITLE && sub && <span className="muted small"> · {sub}</span>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
