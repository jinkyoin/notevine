// 보드 보기 (FR-PRS-08, 칸반 방식): 폴더 안 노트를 속성 값(기본 status)별 칸으로 나눈다. 카드를 끌어 놓으면 속성이 바뀐다.
import { useState } from "react";
import type { FolderTable as Table } from "../api";
import { useApp } from "../store";
import { boardColumns, groupKeys, NONE } from "../lib/folderViews";
import { openProps } from "./TabBar";
import { subFolder } from "./FolderTable";

import { tx } from "../i18n";
const DRAG = "application/x-notevine-card";

export function FolderBoard({ table }: { table: Table }) {
  const folder = useApp((s) => s.tableView) ?? "";
  const statuses = useApp((s) => s.config.idea_statuses);
  const openPath = useApp((s) => s.openPath);
  const keys = groupKeys(table);
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const key = picked && keys.includes(picked) ? picked : keys.includes("status") ? "status" : (keys[0] ?? "status");
  const cols = boardColumns(table.rows, key, key === "status" ? statuses : []);
  const { openNote, setNoteProperty } = useApp.getState();
  // A second property shown on cards, such as a deadline.
  const extra = table.columns.find((c) => c !== key && /deadline|due|마감|기한|date|날짜/i.test(c));

  return (
    <div className="board">
      <div className="board-bar">
        <label className="muted small">
          {tx("묶을 속성")}{" "}
          <select value={key} onChange={(e) => setPicked(e.target.value)}>
            {(keys.includes(key) ? keys : [key, ...keys]).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">{tx("카드를 다른 칸으로 끌어 놓으면 노트의 {0} 값이 바뀝니다.", key)}</span>
      </div>
      <div className="board-cols">
        {cols.map((c) => (
          <section
            key={c.value}
            className={`board-col${hover === c.value ? " drop" : ""}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG)) return;
              e.preventDefault();
              setHover(c.value);
            }}
            onDragLeave={() => setHover(null)}
            onDrop={(e) => {
              setHover(null);
              const path = e.dataTransfer.getData(DRAG);
              const row = table.rows.find((r) => r.path === path);
              if (row && (row.props[key]?.trim() ?? NONE) !== c.value) void setNoteProperty(path, key, c.value === NONE ? undefined : c.value);
            }}
          >
            <h4>
              {c.value === NONE ? tx("{0} 없음", key) : c.value} <span className="count">{c.rows.length}</span>
            </h4>
            <ul>
              {c.rows.map((r) => {
                const sub = subFolder(folder, r.path, r.title);
                return (
                  <li
                    key={r.path}
                    className={`card${r.path === openPath ? " active" : ""}`}
                    title={r.path}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData(DRAG, r.path)}
                    {...openProps((o) => openNote(r.path, undefined, undefined, o))}
                  >
                    <span className="card-title">{r.title}</span>
                    {(sub || (extra && r.props[extra])) && (
                      <span className="muted small">
                        {[sub, extra && r.props[extra] ? `${extra} ${r.props[extra]}` : ""].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
