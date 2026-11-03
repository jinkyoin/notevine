// SCR-11 빠른 열기 (Ctrl+O): 파일명 검색, 최근 연 노트가 위로. Shift+Enter는 새 노트.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteRef } from "../api";
import { useApp } from "../store";
import { rankNotes } from "../lib/fuzzy";

import { tx } from "../i18n";
export function QuickOpen() {
  const open = useApp((s) => s.quickOpen);
  const setQuickOpen = useApp((s) => s.setQuickOpen);
  const notes = useApp((s) => s.notes);
  const recent = useApp((s) => s.recent);
  const openNote = useApp((s) => s.openNote);
  const followLink = useApp((s) => s.followLink);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);

  const items: NoteRef[] = useMemo(() => rankNotes(notes, q, recent).slice(0, 50), [notes, q, recent]);

  useEffect(() => {
    list.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const close = () => setQuickOpen(false);
  const choose = (n: NoteRef | undefined) => {
    if (!n) return;
    close();
    openNote(n.path);
  };
  const create = () => {
    const name = q.trim();
    if (!name) return;
    close();
    void followLink(name);
  };

  return (
    <div className="modal-backdrop top" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder={tx("노트 이름으로 찾기")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, items.length - 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            else if (e.key === "Enter" && e.shiftKey) create();
            else if (e.key === "Enter") items.length ? choose(items[sel]) : create();
            else return;
            e.preventDefault();
          }}
        />
        <ul className="palette-list" ref={list}>
          {items.map((n, i) => (
            <li key={n.path} className={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => choose(n)}>
              <span>{n.title}</span>
              <span className="muted small">{n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : ""}</span>
            </li>
          ))}
          {q.trim() && (
            <li className="create" onClick={create}>
              {tx("＋ \"{0}\" 새 노트 만들기", q.trim())}{" "} <span className="muted small">Shift+Enter</span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
