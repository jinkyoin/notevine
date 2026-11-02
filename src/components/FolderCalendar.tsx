// 캘린더 보기 (FR-PRS-08): 폴더 안 노트를 날짜 속성(또는 날짜 이름·수정일)에 따라 달력에 놓는다.
import { useState } from "react";
import type { FolderTable as Table } from "../api";
import { useApp } from "../store";
import { day, MODIFIED, type TableRow } from "../lib/folderTable";
import { BY_NAME, dateFields, monthGrid, noteDate } from "../lib/folderViews";
import { openProps } from "./TabBar";

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const SHOWN = 4; // notes listed per day before "+n"

export function FolderCalendar({ table }: { table: Table }) {
  const preset = useApp((s) => s.config.preset_enabled);
  const openPath = useApp((s) => s.openPath);
  const fields = dateFields(table);
  const [picked, setPicked] = useState<string | null>(null);
  const field = picked && fields.includes(picked) ? picked : (fields.find((f) => f === "created") ?? fields[0]);
  const today = day(Date.now());
  const [month, setMonth] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }));
  const [open, setOpen] = useState<string | null>(null); // day expanded to all its notes
  const { openNote, openJournalOn } = useApp.getState();

  const byDay = new Map<string, TableRow[]>();
  let undated = 0;
  for (const r of table.rows) {
    const d = noteDate(r, field);
    if (!d) undated++;
    else byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const days = monthGrid(month.y, month.m);
  const prefix = `${month.y}-${String(month.m + 1).padStart(2, "0")}`;
  const step = (n: number) => setMonth(({ y, m }) => ({ y: y + Math.floor((m + n) / 12), m: (((m + n) % 12) + 12) % 12 }));
  const label = (f: string) => (f === MODIFIED ? "수정일" : f === BY_NAME ? "노트 이름의 날짜" : f);

  return (
    <div className="calendar">
      <div className="board-bar">
        <button className="icon-btn" aria-label="이전 달" title="이전 달" onClick={() => step(-1)}>
          ‹
        </button>
        <strong className="cal-month">
          {month.y}년 {month.m + 1}월
        </strong>
        <button className="icon-btn" aria-label="다음 달" title="다음 달" onClick={() => step(1)}>
          ›
        </button>
        <button className="btn ghost small" onClick={() => setMonth({ y: new Date().getFullYear(), m: new Date().getMonth() })}>
          오늘
        </button>
        <span className="spacer" />
        <label className="muted small">
          날짜 기준{" "}
          <select value={field} onChange={(e) => setPicked(e.target.value)}>
            {fields.map((f) => (
              <option key={f} value={f}>
                {label(f)}
              </option>
            ))}
          </select>
        </label>
        {undated > 0 && <span className="muted small">날짜 없는 노트 {undated}개</span>}
      </div>
      <div className="cal-grid">
        {WEEK.map((w, i) => (
          <div key={w} className={`cal-week${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}>
            {w}
          </div>
        ))}
        {days.map((d, i) => {
          const notes = byDay.get(d) ?? [];
          const all = open === d;
          return (
            <div
              key={d}
              data-day={d}
              className={`cal-day${d.startsWith(prefix) ? "" : " other"}${d === today ? " today" : ""}${i % 7 === 0 ? " sun" : i % 7 === 6 ? " sat" : ""}`}
            >
              <div className="cal-day-head">
                <span className="cal-num">{Number(d.slice(8))}</span>
                {preset && (
                  <button className="cal-add" title={`${d} 업무일지 열기`} aria-label={`${d} 업무일지 열기`} onClick={() => void openJournalOn(d)}>
                    ＋
                  </button>
                )}
              </div>
              <ul>
                {(all ? notes : notes.slice(0, SHOWN)).map((r) => (
                  <li key={r.path} className={r.path === openPath ? "active" : ""} title={r.path} {...openProps((o) => openNote(r.path, undefined, undefined, o))}>
                    {r.title}
                  </li>
                ))}
              </ul>
              {notes.length > SHOWN && (
                <button className="link-btn small" onClick={() => setOpen(all ? null : d)}>
                  {all ? "접기" : `+${notes.length - SHOWN}개 더`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
