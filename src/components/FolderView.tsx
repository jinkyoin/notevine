// 폴더 보기: 편집기 자리에 폴더 안 노트를 표(FR-PRP-05)·보드·캘린더(FR-PRS-08)·그래프(FR-UI-05)로 본다.
import { useEffect, useState } from "react";
import { api, type FolderTable as Table } from "../api";
import { useApp, type FolderMode } from "../store";
import { FolderTable } from "./FolderTable";
import { FolderBoard } from "./FolderBoard";
import { FolderCalendar } from "./FolderCalendar";
import { FolderGraph } from "./FolderGraph";

import { tx } from "../i18n";
import { paraInfo } from "../lib/para";
export const MODE_LABEL: Record<FolderMode, string> = { table: tx("표"), board: tx("보드"), calendar: tx("캘린더"), graph: tx("그래프") };

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
  // The base structure's "_안내" notes (type: guide) aren't work to show either.
  const notes =
    table && mode !== "table" ? { ...table, rows: table.rows.filter((r) => !r.path.startsWith(templates + "/") && r.props.type !== "guide") } : table;
  const info = paraInfo(folder, useApp((s) => s.config));

  return (
    <div className="folder-table">
      <div className="folder-table-head">
        <h2 title={info ?? undefined}>{folder || tx("노트 폴더 전체")}</h2>
        {notes && mode !== "graph" && <span className="muted small">{tx("노트 {0}개", notes.rows.length)}</span>}
        <span className="spacer" />
        <div className="fb-mode" role="tablist" aria-label={tx("보기 방식")}>
          {(Object.keys(MODE_LABEL) as FolderMode[]).map((m) => (
            <button key={m} role="tab" aria-selected={m === mode} className={m === mode ? "on" : ""} onClick={() => setTableView(folder, m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <button className="icon-btn" title={tx("닫기 (Esc)")} aria-label={tx("폴더 보기 닫기")} onClick={() => setTableView(null)}>
          ×
        </button>
      </div>
      {info && <p className="muted small folder-info">{info}</p>}
      {mode === "graph" ? (
        <FolderGraph folder={folder} />
      ) : error ? (
        <p className="error pad">{tx("노트 목록을 읽지 못했습니다: {0}", error)}</p>
      ) : !notes ? null : !notes.rows.length ? (
        <p className="muted pad">{tx("이 폴더에는 노트가 없습니다.")}</p>
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
