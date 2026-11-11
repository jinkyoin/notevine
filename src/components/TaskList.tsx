// 할 일 모아 보기 (FR-PRS-09): the task boxes of every note, by due date. Ticking one
// changes that line in its note; clicking the text opens the note at that line.
import { useEffect, useState } from "react";
import { api, type TaskItem } from "../api";
import { useApp } from "../store";
import { tx } from "../i18n";
import { groupTasks, localToday, taskLabel, toggleTaskLine, type TaskGroupKey } from "../lib/tasks";

const groupLabel = (key: TaskGroupKey): string =>
  ({
    overdue: tx("기한 지남"),
    today: tx("오늘"),
    upcoming: tx("다가오는 일"),
    none: tx("기한 없음"),
    done: tx("완료"),
  })[key];

const keyOf = (t: TaskItem) => `${t.path}\n${t.line}`;

export function TaskList() {
  const templateFolder = useApp((s) => s.config.template_folder);
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  const notes = useApp((s) => s.notes);
  const openNote = useApp((s) => s.openNote);
  const [withDone, setWithDone] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);

  useEffect(() => {
    // Template notes hold sample tasks, not real ones.
    const templates = templateFolder + "/";
    api
      .tasks(withDone)
      .then((list) => setTasks(list.filter((t) => !t.path.startsWith(templates))))
      .catch(() => setTasks([]));
  }, [savedSeq, externalSeq, notes, templateFolder, withDone]);

  const toggle = async (t: TaskItem) => {
    const ok = await useApp
      .getState()
      .editNote(
        t.path,
        (text) => toggleTaskLine(text, t.line, t.text),
        tx("노트가 그사이 바뀌어 할 일을 바꾸지 못했습니다. 목록을 새로 고친 뒤 다시 해 주세요"),
      );
    // Shown at once; the list is read again when the note is saved.
    if (ok) setTasks((list) => list.map((x) => (keyOf(x) === keyOf(t) ? { ...x, done: !x.done } : x)));
  };

  const today = localToday();
  const groups = groupTasks(tasks, today);

  return (
    <div className="idea-board task-list">
      <div className="pane-toolbar">
        <span className="pane-title">{tx("할 일")}</span>
        <label className="small task-done-toggle">
          <input type="checkbox" checked={withDone} onChange={(e) => setWithDone(e.target.checked)} /> {tx("완료 포함")}
        </label>
      </div>
      <div className="idea-groups">
        {groups.length === 0 && (
          <p className="muted small pad">
            {tx("노트에 '- [ ] 할 일'처럼 적으면 여기에 모입니다. 기한은 '📅 2026-11-12'처럼 붙입니다.")}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.key} className={`idea-group task-group ${g.key}`}>
            <h4>
              {groupLabel(g.key)} <span className="count">{g.items.length}</span>
            </h4>
            <ul>
              {g.items.map((t) => (
                <li key={keyOf(t)} className={t.done ? "done" : ""} title={`${t.path}:${t.line}`}>
                  <input
                    type="checkbox"
                    checked={t.done}
                    aria-label={tx("완료")}
                    onChange={() => void toggle(t)}
                  />
                  <button className="task-body" onClick={() => openNote(t.path, t.line)}>
                    <span className="task-text">{taskLabel(t.text)}</span>
                    <span className="task-meta">
                      {t.title}
                      {t.due && <span className={`task-due ${!t.done && t.due < today ? "late" : ""}`}>{t.due}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
