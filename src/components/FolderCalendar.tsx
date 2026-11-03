// 캘린더 보기 (FR-PRS-08): 폴더 안 노트를 날짜 속성(또는 날짜 이름·수정일)에 따라 달력에 놓는다.
import { useState } from "react";
import type { FolderTable as Table } from "../api";
import { useApp } from "../store";
import { day, MODIFIED, type TableRow } from "../lib/folderTable";
import { BY_NAME, dateFields, monthGrid, noteDate } from "../lib/folderViews";
import { openProps } from "./TabBar";

import { tx } from "../i18n";
const WEEK = [tx("일"), tx("월"), tx("화"), tx("수"), tx("목"), tx("금"), tx("토")];
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
  const label = (f: string) => (f === MODIFIED ? tx("수정일") : f === BY_NAME ? tx("노트 이름의 날짜") : f);

  return (
    <div className="calendar">
      <div className="board-bar">
        <button className="icon-btn" aria-label={tx("이전 달")} title={tx("이전 달")} onClick={() => step(-1)}>
          ‹
        </button>
        <strong className="cal-month">
          {tx("{0}년 {1}월", month.y, month.m + 1)}
        </strong>
        <button className="icon-btn" aria-label={tx("다음 달")} title={tx("다음 달")} onClick={() => step(1)}>
          ›
        </button>
        <button className="btn ghost small" onClick={() => setMonth({ y: new Date().getFullYear(), m: new Date().getMonth() })}>
          {tx("오늘")}
        </button>
        <button
          className="btn ghost small"
          title={tx("이 달의 업무일지·회의록·프로젝트·아이디어를 모아 월간 회고 노트를 만듭니다")}
          onClick={() => void useApp.getState().createReview("month", new Date(month.y, month.m, 1))}
        >
          {tx("{0}월 회고 만들기", month.m + 1)}
        </button>
        <span className="spacer" />
        <label className="muted small">
          {tx("날짜 기준")}{" "}
          <select value={field} onChange={(e) => setPicked(e.target.value)}>
            {fields.map((f) => (
              <option key={f} value={f}>
                {label(f)}
              </option>
            ))}
          </select>
        </label>
        {undated > 0 && <span className="muted small">{tx("날짜 없는 노트 {0}개", undated)}</span>}
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
                  <button className="cal-add" title={tx("{0} 업무일지 열기", d)} aria-label={tx("{0} 업무일지 열기", d)} onClick={() => void openJournalOn(d)}>
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
                  {all ? tx("접기") : tx("+{0}개 더", notes.length - SHOWN)}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
