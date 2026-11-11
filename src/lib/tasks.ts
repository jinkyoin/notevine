// 할 일 모아 보기 (FR-PRS-09): task boxes of every note, gathered by the index.
import type { TaskItem } from "../api";

/** A task box line: indentation, `>` quotes, a list marker, then `[ ]` or `[x]`. */
const TASK = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)]) \[)([ xX])\](.*)$/;
const DUE = /\s*📅\s*\d{4}-\d{2}-\d{2}\s*/;

/**
 * Flips the task box on `line` (1-based, whole note), but only when that line is
 * still the task whose text is `expected`: the note may have changed since the
 * list was made, and then nothing is touched (null).
 */
export function toggleTaskLine(text: string, line: number, expected: string): string | null {
  const lines = text.split("\n");
  const i = line - 1;
  if (i < 0 || i >= lines.length) return null;
  const cr = lines[i].endsWith("\r");
  const body = cr ? lines[i].slice(0, -1) : lines[i];
  const m = TASK.exec(body);
  if (!m || m[3].trim() !== expected.trim()) return null;
  lines[i] = m[1] + (m[2] === " " ? "x" : " ") + "]" + m[3] + (cr ? "\r" : "");
  return lines.join("\n");
}

/** The task's text without its `📅 YYYY-MM-DD` mark (the date is shown on its own). */
export function taskLabel(text: string): string {
  return text.replace(DUE, " ").trim();
}

export type TaskGroupKey = "overdue" | "today" | "upcoming" | "none" | "done";

export interface TaskGroup {
  key: TaskGroupKey;
  items: TaskItem[];
}

const ORDER: TaskGroupKey[] = ["overdue", "today", "upcoming", "none", "done"];

/** Groups tasks for the list; `today` is YYYY-MM-DD. Keeps the order given within a group. */
export function groupTasks(tasks: TaskItem[], today: string): TaskGroup[] {
  const by = new Map<TaskGroupKey, TaskItem[]>(ORDER.map((k) => [k, []]));
  for (const t of tasks) {
    const key: TaskGroupKey = t.done
      ? "done"
      : !t.due
        ? "none"
        : t.due < today
          ? "overdue"
          : t.due === today
            ? "today"
            : "upcoming";
    by.get(key)!.push(t);
  }
  return ORDER.map((key) => ({ key, items: by.get(key)! })).filter((g) => g.items.length > 0);
}

/** Today in local time as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
