// 속성 표 보기 (FR-PRP-05): 폴더 안 노트를 속성 열로 된 표로 본다. 열 제목으로 정렬, 행을 누르면 노트가 열린다.
import { useEffect, useMemo, useState } from "react";
import { api, type FolderTable as Table } from "../api";
import { useApp } from "../store";
import { cell, MODIFIED, sortRows, TITLE } from "../lib/folderTable";
import { parentPath } from "../lib/tree";
import { openProps } from "./TabBar";

export function FolderTable({ folder }: { folder: string }) {
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  const [table, setTable] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: string; desc: boolean }>({
    col: TITLE,
    desc: false,
  });

  useEffect(() => {
    let live = true;
    api
      .folderTable(folder)
      .then((t) => live && (setTable(t), setError(null)))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [folder, savedSeq, externalSeq]);

  // Esc goes back to the note, unless a dialog is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if (e.key === "Escape" && !s.modal && !s.quickOpen && !s.versionView) s.setTableView(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = useMemo(() => (table ? sortRows(table.rows, sort.col, sort.desc) : []), [table, sort]);
  const cols = table ? [TITLE, ...table.columns, MODIFIED] : [];
  const label = (col: string) => (col === TITLE ? "제목" : col === MODIFIED ? "수정일" : col);
  const { openNote, setTableView } = useApp.getState();

  return (
    <div className="folder-table">
      <div className="folder-table-head">
        <h2>{folder || "노트 폴더 전체"}</h2>
        {table && <span className="muted small">노트 {table.rows.length}개</span>}
        <span className="spacer" />
        <button className="icon-btn" title="표 닫기 (Esc)" aria-label="표 닫기" onClick={() => setTableView(null)}>
          ×
        </button>
      </div>
      {error && <p className="error pad">표를 만들지 못했습니다: {error}</p>}
      {table && !rows.length && <p className="muted pad">이 폴더에는 노트가 없습니다.</p>}
      {!!rows.length && (
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
                      title="눌러서 정렬"
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
                // Subfolder the note sits in, relative to this folder; left out for a
                // project's own overview note ("이사/이사.md"), where it only repeats the title.
                let sub = parentPath(r.path).slice(folder ? folder.length + 1 : 0);
                if (sub === r.title || sub.endsWith("/" + r.title))
                  sub = sub.slice(0, -r.title.length).replace(/\/$/, "");
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
      )}
    </div>
  );
}
