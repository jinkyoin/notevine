import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath as openWithOs, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  errorMessage,
  type LinkChange,
  type NoteRef,
  type TreeNode,
  type VaultChanged,
  type VaultConfig,
  type VaultInfo,
} from "./api";
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

/** What the editor exposes to AI writing (SCR-20). */
export interface EditorApi {
  /** Selected text, or the paragraph around the cursor when nothing is selected (`whole`). */
  selection(): { from: number; to: number; text: string; whole: boolean };
  /** Replaces [from, to) if it still holds `expect`; an undoable edit. */
  replace(from: number, to: number, text: string, expect: string): boolean;
}

export type Modal = "palette" | "quickMemo" | "template" | "settings" | "deleted" | null;
export type SidebarTab = "files" | "search" | "ideas";

/** Defaults used until the vault's config is loaded (mirrors the backend defaults). */
export const DEFAULT_CONFIG: VaultConfig = {
  preset_enabled: false,
  inbox_folder: "00 Inbox",
  journal_folder: "10 업무일지",
  idea_folder: "20 아이디어",
  research_folder: "30 조사자료",
  template_folder: "90 템플릿",
  attachment_folder: "첨부",
  journal_path: "10 업무일지/{{YYYY}}/{{YYYY-MM-DD}}.md",
  idea_statuses: ["아이디어", "검토", "진행", "완료", "보류"],
  link_click: "ctrl",
  update_links_on_rename: true,
  autosave_ms: 1000,
  theme: "system",
  language: "ko",
};

/** Applies the theme setting (FR-UI-02) to the document. */
export function applyTheme(theme: VaultConfig["theme"]) {
  document.documentElement.dataset.theme = theme;
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
  /** Show the note formatted (read mode) instead of the editor (Ctrl+E). */
  readMode: boolean;
  /** Bumped after each save so panels that depend on links refresh. */
  savedSeq: number;
  sidebarTab: SidebarTab;
  editorApi: EditorApi | null;
  /** In-app confirmation waiting for an answer (see ConfirmDialog). */
  confirm: { title: string; message: string; okLabel: string; resolve: (ok: boolean) => void } | null;
  config: VaultConfig;
  modal: Modal;
  /** Version viewer (SCR-10): the note and the version to select first. */
  versionView: { path: string; id: number | null } | null;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Back/forward note navigation (Alt+←/→). */
  back: string[];
  forward: string[];
  /** Bumped to move focus into the search box (Ctrl+Shift+F). */
  searchFocusSeq: number;
  quickOpen: boolean;
  /** Recently opened note paths, newest first (quick open ordering). */
  recent: string[];
  /** Current editor text (debounced), for the properties panel; null when no note is open. */
  docText: string | null;
  /**
   * Edits the open note's text as if typed (undoable, autosaved). `fn` returns
   * the new text, or null to refuse. Returns false when it was refused.
   */
  editText: (fn: (text: string) => string | null) => boolean;
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
  /** Opens a non-note file with its default program (FR-ATT-05). */
  openAttachment(target: string): Promise<void>;
  confirmRelocate(updateLinks: boolean | null): Promise<void>;
  noteSaved(): void;
  setSidebarTab(tab: SidebarTab): void;
  setModal(m: Modal): void;
  /** Opens the right panel and puts the cursor in the AI question box. */
  focusAi(): void;
  setEditorApi(e: EditorApi | null): void;
  /** Asks in an in-app dialog; resolves true when the user agrees. */
  ask(title: string, message: string, okLabel: string): Promise<boolean>;
  setVersionView(v: { path: string; id: number | null } | null): void;
  setPanels(p: { leftOpen?: boolean; rightOpen?: boolean }): void;
  goBack(): void;
  setReadMode(on: boolean): void;
  goForward(): void;
  saveConfig(c: VaultConfig): Promise<void>;
  applyPreset(): Promise<void>;
  openTodayJournal(): Promise<void>;
  /** Folder new notes go to: the open note's folder, else the vault root. */
  currentDir(): string;
  /** Creates a note (optionally from a template); without a name it starts renaming it in the tree. */
  createFromTemplate(dir: string, template: string | null, name?: string): Promise<void>;
  focusSearch(): void;
  setQuickOpen(open: boolean): void;
  setDocText(text: string | null): void;
  setEditText(fn: AppStore["editText"]): void;
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
    readMode: false,
    savedSeq: 0,
    sidebarTab: "files",
    editorApi: null,
    confirm: null,
    config: DEFAULT_CONFIG,
    modal: null,
    versionView: null,
    leftOpen: true,
    rightOpen: true,
    back: [],
    forward: [],
    searchFocusSeq: 0,
    quickOpen: false,
    recent: [],
    docText: null,
    editText: () => false,
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
      set({ vault: info, tree: [], expanded: new Set(), openPath: null, editing: null, back: [], forward: [] });
      const config = await api.getConfig().catch(() => DEFAULT_CONFIG);
      set({ config, sidebarTab: get().sidebarTab === "ideas" && !config.preset_enabled ? "files" : get().sidebarTab });
      applyTheme(config.theme);
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
      const prev = get().openPath;
      set({
        back: prev && prev !== path ? [...get().back, prev].slice(-50) : get().back,
        forward: prev && prev !== path ? [] : get().forward,
        openPath: path,
        jumpLine: line ?? null,
        recent: [path, ...get().recent.filter((p) => p !== path)].slice(0, 30),
      });
      void api.setWorkspace(path).catch(() => {});
    },

    setReadMode(readMode) {
      set({ readMode });
    },

    async createNote(dir) {
      const path = await attempt(() => api.createNote(dir));
      if (!path) return;
      set({ readMode: false }); // a new note is for writing
      await get().refreshTree();
      get().openNote(path);
      // Name it inline in the file tree, so make sure the tree is showing.
      set({ editing: { mode: "rename", path }, sidebarTab: "files", leftOpen: true });
    },

    async createFolder(parent, name) {
      const path = await attempt(() => api.createFolder(parent, name));
      if (!path) return;
      await get().refreshTree();
      expandTo(path + "/");
    },

    async openAttachment(target) {
      const rel = await api.resolveAttachment(target, get().openPath ?? "").catch(() => null);
      const folder = get().config.attachment_folder;
      if (!rel) {
        get().toast(`첨부 파일을 찾을 수 없음: ${target}`, "error", {
          label: "폴더 열기",
          run: () => {
            const root = get().vault?.root;
            if (root) void revealItemInDir(`${root}\\${folder.replace(/\//g, "\\")}`).catch(() => {});
          },
        });
        return;
      }
      try {
        await openWithOs(await api.attachmentPath(rel));
      } catch (e) {
        get().toast(`파일을 열지 못했습니다: ${errorMessage(e)}`, "error");
      }
    },

    async followLink(target) {
      // [[견적서.xlsx]] and other non-note files open in their own program.
      if (/\.[a-z0-9]{1,8}$/i.test(target) && !/\.md$/i.test(target)) return get().openAttachment(target);
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

    setSidebarTab(sidebarTab) {
      set({ sidebarTab });
    },

    setModal(modal) {
      set({ modal });
    },

    focusAi() {
      set({ rightOpen: true });
      // After the panel renders.
      setTimeout(() => document.querySelector<HTMLTextAreaElement>(".ai-input textarea")?.focus(), 0);
    },

    setEditorApi(editorApi) {
      set({ editorApi });
    },

    ask(title, message, okLabel) {
      return new Promise((resolve) => set({ confirm: { title, message, okLabel, resolve } }));
    },

    setVersionView(versionView) {
      set({ versionView });
    },

    setPanels(p) {
      set(p);
    },

    goBack() {
      const { back, openPath, tree } = get();
      const target = [...back].reverse().find((p) => findNode(tree, p));
      if (!target) return;
      void get().flushEditor();
      set({
        back: back.slice(0, back.lastIndexOf(target)),
        forward: openPath ? [openPath, ...get().forward] : get().forward,
        openPath: target,
        jumpLine: null,
      });
      expandTo(target);
    },

    goForward() {
      const { forward, openPath, tree } = get();
      const target = forward.find((p) => findNode(tree, p));
      if (!target) return;
      void get().flushEditor();
      set({
        forward: forward.slice(forward.indexOf(target) + 1),
        back: openPath ? [...get().back, openPath] : get().back,
        openPath: target,
        jumpLine: null,
      });
      expandTo(target);
    },

    async saveConfig(config) {
      const ok = await attempt(() => api.setConfig(config).then(() => true));
      if (!ok) return;
      set({ config });
      applyTheme(config.theme);
    },

    async applyPreset() {
      const c = get().config;
      const folders = [c.inbox_folder, c.journal_folder, c.idea_folder, c.research_folder, c.template_folder, c.attachment_folder];
      const ok = await get().ask(
        "기본 구조 만들기",
        `노트 폴더에 다음 폴더와 템플릿 4개(업무일지·회의록·아이디어·자료)를 만듭니다.\n\n${folders.join("\n")}\n\n이미 있는 폴더와 노트는 바꾸지 않습니다.`,
        "켜기",
      );
      if (!ok) return;
      const r = await attempt(() => api.applyPreset());
      if (!r) return;
      const config = await api.getConfig().catch(() => get().config);
      set({ config });
      await get().refreshTree();
      const made = r.created_folders.length + r.created_templates.length;
      get().toast(
        made
          ? `기본 구조를 만들었습니다 · 폴더 ${r.created_folders.length}개, 템플릿 ${r.created_templates.length}개`
          : "기본 구조를 켰습니다 · 이미 있는 폴더와 템플릿은 그대로 두었습니다",
      );
    },

    async openTodayJournal() {
      // The journal lives in the preset's folders; offer to set them up first.
      if (!get().config.preset_enabled) {
        await get().applyPreset();
        if (!get().config.preset_enabled) return;
      }
      const path = await attempt(() => api.openTodayJournal());
      if (!path) return;
      await get().refreshTree();
      get().openNote(path);
    },

    currentDir() {
      const p = get().openPath;
      return p ? parentOf(p) : "";
    },

    async createFromTemplate(dir, template, name) {
      const path = await attempt(() => api.createFromTemplate(dir, name?.trim() || null, template));
      if (!path) return;
      await get().refreshTree();
      get().openNote(path);
      if (name?.trim()) return;
      // Name it inline in the file tree, so make sure the tree is showing.
      set({ editing: { mode: "rename", path }, sidebarTab: "files", leftOpen: true });
    },

    focusSearch() {
      set({ sidebarTab: "search", searchFocusSeq: get().searchFocusSeq + 1 });
    },

    setQuickOpen(quickOpen) {
      set({ quickOpen });
    },

    setDocText(docText) {
      set({ docText });
    },

    setEditText(editText) {
      set({ editText });
    },

    async rename(path, newName) {
      await get().flushEditor();
      if (!get().config.update_links_on_rename) return doRename(path, newName, false);
      const changes = await attempt(() => api.previewRename(path, newName));
      if (!changes) return;
      if (changes.length) return set({ pendingRelocate: { kind: "rename", path, arg: newName, changes } });
      await doRename(path, newName, true);
    },

    async move(path, newParent) {
      await get().flushEditor();
      if (!get().config.update_links_on_rename) return doMove(path, newParent, false);
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
