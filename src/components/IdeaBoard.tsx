// SCR-06 아이디어 보드 (프리셋): 상태별 묶음, 끌어 놓거나 우클릭으로 상태 변경, Inbox 미분류 (FR-PRS-05·06).
import { useEffect, useState } from "react";
import { api, type IdeaItem } from "../api";
import { useApp } from "../store";
import { noteTitle } from "../lib/tree";

import { tx } from "../i18n";
const DRAG = "application/x-notevine-idea";

const changeStatus = (path: string, status: string) => useApp.getState().setNoteProperty(path, "status", status);

export function IdeaBoard() {
  const config = useApp((s) => s.config);
  const notes = useApp((s) => s.notes);
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  const openPath = useApp((s) => s.openPath);
  const openNote = useApp((s) => s.openNote);
  const setModal = useApp((s) => s.setModal);
  const [ideas, setIdeas] = useState<IdeaItem[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  useEffect(() => {
    // Templates are not ideas, even though the idea template has type: idea.
    const templates = config.template_folder + "/";
    api
      .ideas()
      .then((list) => setIdeas(list.filter((i) => !i.path.startsWith(templates))))
      .catch(() => setIdeas([]));
  }, [savedSeq, externalSeq, notes, config.template_folder]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const statuses = config.idea_statuses;
  const groups: [string, IdeaItem[]][] = statuses.map((s) => [s, ideas.filter((i) => i.status === s)]);
  const other = ideas.filter((i) => !statuses.includes(i.status));
  if (other.length) groups.push([tx("기타"), other]);
  const ideaPaths = new Set(ideas.map((i) => i.path));

  const inbox = notes.filter((n) => n.path.startsWith(config.inbox_folder + "/") && !ideaPaths.has(n.path));

  const dropTo = (status: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (status === null || !e.dataTransfer.types.includes(DRAG)) return;
      e.preventDefault();
      setHover(status);
    },
    onDragLeave: () => setHover(null),
    onDrop: (e: React.DragEvent) => {
      setHover(null);
      const path = e.dataTransfer.getData(DRAG);
      if (path && status !== null) void changeStatus(path, status);
    },
  });

  const Item = ({ path, title }: { path: string; title: string }) => (
    <li
      className={path === openPath ? "active" : ""}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(DRAG, path)}
      onClick={() => openNote(path)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, path });
      }}
      title={path}
    >
      {title}
    </li>
  );

  return (
    <div className="idea-board">
      <div className="pane-toolbar">
        <span className="pane-title">{tx("아이디어")}</span>
        <button className="btn ghost small" onClick={() => setModal("quickMemo")} title="Ctrl+Shift+N">
          {tx("＋ 빠른 메모")}
        </button>
      </div>
      <div className="idea-groups">
        {groups.map(([status, items]) => (
          <section key={status} className={`idea-group ${hover === status ? "drop" : ""}`} {...dropTo(status === tx("기타") ? null : status)}>
            <h4>
              {status} <span className="count">{items.length}</span>
            </h4>
            <ul>
              {items.map((i) => (
                <Item key={i.path} path={i.path} title={i.title} />
              ))}
            </ul>
          </section>
        ))}
        <section className="idea-group inbox">
          <h4>
            {tx("{0} · 상태 없음", config.inbox_folder)}{" "} <span className="count">{inbox.length}</span>
          </h4>
          <ul>
            {inbox.map((n) => (
              <Item key={n.path} path={n.path} title={noteTitle(n.path)} />
            ))}
          </ul>
        </section>
      </div>
      {menu && (
        <ul className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <li className="menu-label">{tx("상태 변경")}</li>
          {statuses.map((s) => (
            <li
              key={s}
              onClick={() => {
                setMenu(null);
                void changeStatus(menu.path, s);
              }}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
