// 폴더 보기: 편집기 자리에 폴더 안 노트를 표(FR-PRP-05)·보드·캘린더(FR-PRS-08)·그래프(FR-UI-05)로 본다.
import { useEffect, useState } from "react";
import { api, type FolderTable as Table } from "../api";
import { useApp, type FolderMode } from "../store";
import { FolderTable } from "./FolderTable";
import { FolderBoard } from "./FolderBoard";
import { FolderCalendar } from "./FolderCalendar";
import { FolderGraph } from "./FolderGraph";

export const MODE_LABEL: Record<FolderMode, string> = { table: "표", board: "보드", calendar: "캘린더", graph: "그래프" };

export function FolderView({ folder }: { folder: string }) {
  const mode = useApp((s) => s.folderMode);
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  // Changes when indexing a newly opened folder finishes.
  const indexed = useApp((s) => s.notes);
  const templates = useApp((s) => s.config.template_folder);
  const [table, setTable] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "graph") return;
    let live = true;
    api
      .folderTable(folder)
      .then((t) => live && (setTable(t), setError(null)))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [folder, mode, savedSeq, externalSeq, indexed]);

  // Esc goes back to the note, unless a dialog is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if (e.key === "Escape" && !s.modal && !s.quickOpen && !s.versionView) s.setTableView(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { setTableView } = useApp.getState();
  // Templates hold placeholder statuses and dates; only the table lists them.
  const notes = table && mode !== "table" ? { ...table, rows: table.rows.filter((r) => !r.path.startsWith(templates + "/")) } : table;

  return (
    <div className="folder-table">
      <div className="folder-table-head">
        <h2>{folder || "노트 폴더 전체"}</h2>
        {notes && mode !== "graph" && <span className="muted small">노트 {notes.rows.length}개</span>}
        <span className="spacer" />
        <div className="fb-mode" role="tablist" aria-label="보기 방식">
          {(Object.keys(MODE_LABEL) as FolderMode[]).map((m) => (
            <button key={m} role="tab" aria-selected={m === mode} className={m === mode ? "on" : ""} onClick={() => setTableView(folder, m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="닫기 (Esc)" aria-label="폴더 보기 닫기" onClick={() => setTableView(null)}>
          ×
        </button>
      </div>
      {mode === "graph" ? (
        <FolderGraph folder={folder} />
      ) : error ? (
        <p className="error pad">노트 목록을 읽지 못했습니다: {error}</p>
      ) : !notes ? null : !notes.rows.length ? (
        <p className="muted pad">이 폴더에는 노트가 없습니다.</p>
      ) : mode === "board" ? (
        <FolderBoard table={notes} />
      ) : mode === "calendar" ? (
        <FolderCalendar table={notes} />
      ) : (
        <FolderTable folder={folder} table={notes} />
      )}
    </div>
  );
}
