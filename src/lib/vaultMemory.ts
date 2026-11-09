// 노트 폴더마다 화면에 있던 것 (FR-VLT-07). 앱이 켜져 있는 동안만 메모리에 둔다.
// 폴더를 바꿀 때 떼어 두었다가 그 폴더로 돌아올 때 되살린다.
import type { ClosedTab, Tab } from "./tabs";
import { norm } from "./rail";

export interface VaultSnapshot {
  tabs: Tab[];
  openPath: string | null;
  closedTabs: ClosedTab[];
  splitPath: string | null;
  expanded: string[];
  tableView: string | null;
  pdfView: { path: string; page: number; seq: number } | null;
  canvasView: string | null;
  /** The AI panel's chat and proposals (aiStore's snapshot). */
  ai: unknown;
}

const snapshots = new Map<string, VaultSnapshot>();

export function keepSnapshot(root: string, s: VaultSnapshot): void {
  snapshots.set(norm(root), s);
}

/** The folder's snapshot, removed from memory. */
export function takeSnapshot(root: string): VaultSnapshot | undefined {
  const s = snapshots.get(norm(root));
  snapshots.delete(norm(root));
  return s;
}

export function dropSnapshot(root: string): void {
  snapshots.delete(norm(root));
}

export function clearSnapshots(): void {
  snapshots.clear();
}

/** Key for a note's cursor and scroll: notes with the same path in two folders stay apart. */
export const viewKey = (root: string, path: string) => norm(root) + "\n" + path;
