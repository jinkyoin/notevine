import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, errorMessage, type LinkChange, type NoteRef, type TreeNode, type VaultChanged, type VaultInfo } from "./api";
import { ancestors, findNode, remapPath } from "./lib/tree";

export type ToastKind = "info" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; run: () => void };
}

/** A rename/move waiting for the user to confirm link updates (SCR-15). */
export interface PendingRelocate {
  kind: "rename" | "move";
  path: string;
  /** New name (rename) or new parent folder (move). */
  arg: string;
  changes: LinkChange[];
}

/** A tree row currently being named inline (new note/folder or rename). */
export type Editing = { mode: "rename"; path: string } | { mode: "new-folder"; parent: string };

interface AppStore {
  vault: VaultInfo | null;
  tree: TreeNode[];
  /** Every note (path + title), for link completion and resolution. */
  notes: NoteRef[];
  pendingRelocate: PendingRelocate | null;
  /** Line to put the cursor on when the next note opens (from a backlink). */
  jumpLine: number | null;
  /** Bumped after each save so panels that depend on links refresh. */
  savedSeq: number;
  expanded: Set<string>;
  openPath: string | null;
  editing: Editing | null;
  toasts: Toast[];
  /** Bumped when another program changes notes; the editor reloads if `externalPaths` has its note. */
  externalSeq: number;
  externalPaths: string[];
  /** Set by the editor; saves unsaved text before files move under it. */
  flushEditor: (force?: boolean) => Promise<void>;

  openVault(path: string): Promise<void>;
  closeVault(): Promise<void>;
  refreshTree(): Promise<void>;
  toggleFolder(path: string, open?: boolean): void;
  openNote(path: string, line?: number): void;
  /** Opens the note a link points at, creating it when it doesn't exist (FR-LNK-02). */
  followLink(target: string): Promise<void>;
  confirmRelocate(updateLinks: boolean | null): Promise<void>;
  noteSaved(): void;
  createNote(dir: string): Promise<void>;
  createFolder(parent: string, name: string): Promise<void>;
  rename(path: string, newName: string): Promise<void>;
  move(path: string, newParent: string): Promise<void>;
  remove(path: string): Promise<void>;
  setEditing(e: Editing | null): void;
  setFlushEditor(fn: (force?: boolean) => Promise<void>): void;
  toast(message: string, kind?: ToastKind, action?: Toast["action"]): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;

function parentOf(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function baseOf(p: string) {
  return p.slice(p.lastIndexOf("/") + 1);
}
let unlistenChanges: UnlistenFn | null = null;
let treeTimer: number | undefined;

export const useApp = create<AppStore>((set, get) => {
  /** Runs a backend call and reports failures as an error toast. */
  async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      get().toast(errorMessage(e), "error");
      return undefined;
    }
  }

  async function doRename(path: string, newName: string, updateLinks: boolean) {
    const to = await attempt(() => api.renameEntry(path, newName, updateLinks));
    if (!to) return;
    await afterRelocate(path, to);
  }

  async function doMove(path: string, newParent: string, updateLinks: boolean) {
    const to = await attempt(() => api.moveEntry(path, newParent, updateLinks));
    if (!to || to === path) return;
    await afterRelocate(path, to);
    expandTo(to);
  }

  async function afterRelocate(from: string, to: string) {
    const { openPath } = get();
    // Set the new path before the tree refresh so it isn't reported as deleted.
    if (openPath) set({ openPath: remapPath(openPath, from, to) });
    await get().refreshTree();
    get().noteSaved();
  }

  function expandTo(path: string) {
    const expanded = new Set(get().expanded);
    ancestors(path).forEach((p) => expanded.add(p));
    set({ expanded });
  }

  return {
    vault: null,
    tree: [],
    notes: [],
    pendingRelocate: null,
    jumpLine: null,
    savedSeq: 0,
    expanded: new Set(),
    openPath: null,
    editing: null,
    toasts: [],
    externalSeq: 0,
    externalPaths: [],
    flushEditor: async () => {},

    async openVault(path) {
      const info = await attempt(() => api.openVault(path));
      if (!info) return;
      set({ vault: info, tree: [], expanded: new Set(), openPath: null, editing: null });
      await get().refreshTree();

      unlistenChanges?.();
      unlistenChanges = await listen<VaultChanged>("vault-changed", ({ payload }) => {
        if (payload.external.length) {
          set({ externalSeq: get().externalSeq + 1, externalPaths: payload.external });
        }
        // Coalesce bursts (e.g. a sync tool writing many files) into one tree refresh.
        window.clearTimeout(treeTimer);
        treeTimer = window.setTimeout(() => get().refreshTree(), 150);
      });

      // Reopen the note that was open last time (FR-VLT-02).
      const ws = await api.getWorkspace().catch(() => null);
      if (ws?.open_path && findNode(get().tree, ws.open_path)) get().openNote(ws.open_path);
    },

    async closeVault() {
      await get().flushEditor();
      unlistenChanges?.();
      unlistenChanges = null;
      await attempt(() => api.closeVault());
      set({ vault: null, tree: [], openPath: null, editing: null });
    },

    async refreshTree() {
      const [tree, notes] = await Promise.all([attempt(() => api.listTree()), api.listNotes().catch(() => null)]);
      if (notes) set({ notes });
      if (!tree) return;
      set({ tree });
      const { openPath } = get();
      if (openPath && !findNode(tree, openPath)) {
        set({ openPath: null });
        get().toast("열려 있던 노트가 다른 프로그램에서 삭제되거나 이동되었습니다");
      }
    },

    toggleFolder(path, open) {
      const expanded = new Set(get().expanded);
      const next = open ?? !expanded.has(path);
      if (next) expanded.add(path);
      else expanded.delete(path);
      set({ expanded });
    },

    openNote(path, line) {
      void get().flushEditor();
      expandTo(path);
      set({ openPath: path, jumpLine: line ?? null });
      void api.setWorkspace(path).catch(() => {});
    },

    async createNote(dir) {
      const path = await attempt(() => api.createNote(dir));
      if (!path) return;
      await get().refreshTree();
      get().openNote(path);
      set({ editing: { mode: "rename", path } });
    },

    async createFolder(parent, name) {
      const path = await attempt(() => api.createFolder(parent, name));
      if (!path) return;
      await get().refreshTree();
      expandTo(path + "/");
    },

    async followLink(target) {
      const found = await attempt(() => api.resolveLink(target));
      if (found === undefined) return;
      if (found) return get().openNote(found);
      // [[폴더/이름]] creates 폴더/이름.md; a bare [[이름]] creates it at the vault root.
      const clean = target.replace(/\.md$/i, "");
      const slash = clean.lastIndexOf("/");
      const dir = slash < 0 ? "" : clean.slice(0, slash);
      const name = slash < 0 ? clean : clean.slice(slash + 1);
      if (dir && !findNode(get().tree, dir)) {
        await attempt(() => api.createFolder(parentOf(dir), baseOf(dir)));
      }
      const created = await attempt(() => api.createNote(dir, name));
      if (!created) return;
      await get().refreshTree();
      get().openNote(created);
    },

    async confirmRelocate(updateLinks) {
      const p = get().pendingRelocate;
      set({ pendingRelocate: null });
      if (!p || updateLinks === null) return;
      if (p.kind === "rename") await doRename(p.path, p.arg, updateLinks);
      else await doMove(p.path, p.arg, updateLinks);
    },

    noteSaved() {
      set({ savedSeq: get().savedSeq + 1 });
    },

    async rename(path, newName) {
      await get().flushEditor();
      const changes = await attempt(() => api.previewRename(path, newName));
      if (!changes) return;
      if (changes.length) return set({ pendingRelocate: { kind: "rename", path, arg: newName, changes } });
      await doRename(path, newName, true);
    },

    async move(path, newParent) {
      await get().flushEditor();
      const changes = await attempt(() => api.previewMove(path, newParent));
      if (!changes) return;
      if (changes.length) return set({ pendingRelocate: { kind: "move", path, arg: newParent, changes } });
      await doMove(path, newParent, true);
    },

    async remove(path) {
      await get().flushEditor();
      const ok = await attempt(() => api.deleteEntry(path).then(() => true));
      if (!ok) return;
      const { openPath } = get();
      if (openPath && remapPath(openPath, path, "\0") !== openPath) set({ openPath: null });
      await get().refreshTree();
      get().toast("휴지통으로 옮겼습니다");
    },

    setFlushEditor(flushEditor) {
      set({ flushEditor });
    },

    setEditing(editing) {
      set({ editing });
    },

    toast(message, kind = "info", action) {
      const id = ++toastSeq;
      set({ toasts: [...get().toasts, { id, kind, message, action }] });
      // Errors stay until dismissed (SCR-17).
      if (kind === "info") setTimeout(() => get().dismissToast(id), 4000);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});
