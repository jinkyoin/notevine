// SCR-06 아이디어 보드 (프리셋): 상태별 묶음, 끌어 놓거나 우클릭으로 상태 변경, Inbox 미분류 (FR-PRS-05·06).
import { useEffect, useState } from "react";
import { api, errorMessage, type IdeaItem } from "../api";
import { useApp } from "../store";
import { setProperty } from "../lib/frontmatter";
import { noteTitle } from "../lib/tree";

const DRAG = "application/x-notevine-idea";

/** Sets `status` in a note's frontmatter, through the editor when the note is open. */
async function changeStatus(path: string, status: string) {
  const st = useApp.getState();
  if (st.openPath === path) {
    if (!st.editText((t) => setProperty(t, "status", status))) st.toast("속성 YAML에 오류가 있어 상태를 바꾸지 못했습니다", "error");
    return;
  }
  try {
    const text = await api.readNote(path);
    const next = setProperty(text, "status", status);
    if (next === null) return st.toast("속성 YAML에 오류가 있어 상태를 바꾸지 못했습니다", "error");
    const out = await api.writeNote(path, next, true);
    if (out.conflict) st.toast(`다른 프로그램이 동시에 고쳐서 "${out.conflict}"로 따로 저장했습니다`, "error");
    st.noteSaved();
  } catch (e) {
    st.toast(`상태를 바꾸지 못했습니다: ${errorMessage(e)}`, "error");
  }
}

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
    api.ideas().then(setIdeas).catch(() => setIdeas([]));
  }, [savedSeq, externalSeq, notes]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const statuses = config.idea_statuses;
  const groups: [string, IdeaItem[]][] = statuses.map((s) => [s, ideas.filter((i) => i.status === s)]);
  const other = ideas.filter((i) => !statuses.includes(i.status));
  if (other.length) groups.push(["기타", other]);
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
        <span className="pane-title">아이디어</span>
        <button className="btn ghost small" onClick={() => setModal("quickMemo")} title="Ctrl+Shift+N">
          ＋ 빠른 메모
        </button>
      </div>
      <div className="idea-groups">
        {groups.map(([status, items]) => (
          <section key={status} className={`idea-group ${hover === status ? "drop" : ""}`} {...dropTo(status === "기타" ? null : status)}>
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
            {config.inbox_folder} 미분류 <span className="count">{inbox.length}</span>
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
          <li className="menu-label">상태 변경</li>
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
