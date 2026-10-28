import { create } from "zustand";
import { api, errorMessage, type TreeNode, type VaultInfo } from "./api";
import { ancestors, remapPath } from "./lib/tree";

export type ToastKind = "info" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

/** A tree row currently being named inline (new note/folder or rename). */
export type Editing = { mode: "rename"; path: string } | { mode: "new-folder"; parent: string };

interface AppStore {
  vault: VaultInfo | null;
  tree: TreeNode[];
  expanded: Set<string>;
  openPath: string | null;
  editing: Editing | null;
  toasts: Toast[];
  /** Set by the editor; saves unsaved text before files move under it. */
  flushEditor: (force?: boolean) => Promise<void>;

  openVault(path: string): Promise<void>;
  closeVault(): Promise<void>;
  refreshTree(): Promise<void>;
  toggleFolder(path: string, open?: boolean): void;
  openNote(path: string): void;
  createNote(dir: string): Promise<void>;
  createFolder(parent: string, name: string): Promise<void>;
  rename(path: string, newName: string): Promise<void>;
  move(path: string, newParent: string): Promise<void>;
  remove(path: string): Promise<void>;
  setEditing(e: Editing | null): void;
  setFlushEditor(fn: (force?: boolean) => Promise<void>): void;
  toast(message: string, kind?: ToastKind): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;

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

  function expandTo(path: string) {
    const expanded = new Set(get().expanded);
    ancestors(path).forEach((p) => expanded.add(p));
    set({ expanded });
  }

  return {
    vault: null,
    tree: [],
    expanded: new Set(),
    openPath: null,
    editing: null,
    toasts: [],
    flushEditor: async () => {},

    async openVault(path) {
      const info = await attempt(() => api.openVault(path));
      if (!info) return;
      set({ vault: info, tree: [], expanded: new Set(), openPath: null, editing: null });
      await get().refreshTree();
    },

    async closeVault() {
      await get().flushEditor();
      await attempt(() => api.closeVault());
      set({ vault: null, tree: [], openPath: null, editing: null });
    },

    async refreshTree() {
      const tree = await attempt(() => api.listTree());
      if (tree) set({ tree });
    },

    toggleFolder(path, open) {
      const expanded = new Set(get().expanded);
      const next = open ?? !expanded.has(path);
      if (next) expanded.add(path);
      else expanded.delete(path);
      set({ expanded });
    },

    openNote(path) {
      void get().flushEditor();
      expandTo(path);
      set({ openPath: path });
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

    async rename(path, newName) {
      await get().flushEditor();
      const to = await attempt(() => api.renameEntry(path, newName));
      if (!to) return;
      await get().refreshTree();
      const { openPath } = get();
      if (openPath) set({ openPath: remapPath(openPath, path, to) });
    },

    async move(path, newParent) {
      await get().flushEditor();
      const to = await attempt(() => api.moveEntry(path, newParent));
      if (!to || to === path) return;
      await get().refreshTree();
      const { openPath } = get();
      if (openPath) set({ openPath: remapPath(openPath, path, to) });
      expandTo(to);
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

    toast(message, kind = "info") {
      const id = ++toastSeq;
      set({ toasts: [...get().toasts, { id, kind, message }] });
      // Errors stay until dismissed (SCR-17).
      if (kind === "info") setTimeout(() => get().dismissToast(id), 4000);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});
