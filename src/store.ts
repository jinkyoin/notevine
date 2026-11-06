import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath as openWithOs, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  errorMessage,
  type AppError,
  type LinkChange,
  type NoteRef,
  type TreeNode,
  type VaultChanged,
  type VaultConfig,
  type VaultInfo,
  type DeviceTrust,
} from "./api";
import { ancestors, findNode, remapPath } from "./lib/tree";
import { unseenConflicts } from "./lib/driveConflicts";
import { setProperty, type Prop } from "./lib/frontmatter";
import { buildReview, period, reviewFolder, reviewName, type ReviewKind } from "./lib/review";
import { day } from "./lib/folderTable";
import { opensWithoutAsking } from "./lib/openSafety";
import { annotationEntry, annotationNote, annotationPath } from "./lib/pdfNotes";
import type { ParaFolder } from "./lib/para";
import { insertTemplate } from "./editor/template";
import { findBlockLine, findHeadingLine } from "./lib/headings";
import {
  closeOtherTabs,
  closeTab,
  dropTabs,
  goHistory,
  openTab,
  remapTabs,
  reopenTab,
  stepTab,
  type ClosedTab,
  type Tab,
  type Tabs,
} from "./lib/tabs";

import { dateLocale, tx } from "./i18n";
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
  /** Replaces the whole text via `fn(text, cursor)` and moves the cursor; an undoable edit. */
  rewrite(fn: (text: string, cursor: number) => { text: string; cursor: number }): void;
}

export type Modal = "palette" | "quickMemo" | "template" | "settings" | "deleted" | "mdHelp" | "manual" | "clip" | "insertTemplate" | null;
export type SidebarTab = "files" | "search" | "ideas";
/** How a folder is shown in place of the editor: properties table, status board, calendar or link graph. */
export type FolderMode = "table" | "board" | "calendar" | "graph";

/** Defaults used until the vault's config is loaded (mirrors the backend defaults). */
export const DEFAULT_CONFIG: VaultConfig = {
  preset_enabled: false,
  inbox_folder: "00.Inbox",
  project_folder: "10.프로젝트",
  area_folder: "20.영역",
  resource_folder: "30.자료",
  archive_folder: "40.보관",
  journal_folder: "20.영역/업무일지",
  idea_folder: "30.자료/아이디어",
  research_folder: "30.자료/조사자료",
  template_folder: "90.템플릿",
  attachment_folder: "첨부",
  journal_path: "20.영역/업무일지/{{YYYY}}/{{YYYY-MM-DD}}.md",
  idea_statuses: ["아이디어", "검토", "진행", "완료", "보류"],
  link_click: "ctrl",
  update_links_on_rename: true,
  autosave_ms: 1000,
  theme: "system",
  language: "ko",
  folder_colors: {},
  saved_searches: [],
  history_thin_days: 0,
  history_delete_days: 0,
  keybindings: {},
};

const NO_TRUST: DeviceTrust = { git: false, backup_minutes: 0, custom_css: false };

/** Applies the theme setting (FR-UI-02) to the document. */
export function applyTheme(theme: VaultConfig["theme"]) {
  document.documentElement.dataset.theme = theme;
}

/** A tree row currently being named inline (new note/folder or rename). `project`: a new PARA project. */
export type Editing = { mode: "rename"; path: string } | { mode: "new-folder"; parent: string; project?: boolean };
/** How to open a note: in a new tab (Ctrl+click, middle click) instead of the current one. */
export type OpenOpts = { newTab?: boolean };

interface AppStore {
  vault: VaultInfo | null;
  tree: TreeNode[];
  /** Every note (path + title), for link completion and resolution. */
  notes: NoteRef[];
  pendingRelocate: PendingRelocate | null;
  /** Line to put the cursor on when the next note opens (from a backlink). */
  jumpLine: number | null;
  /** Heading the jump is for, so read mode can scroll to it ([[노트#제목]]). */
  jumpHeading: string | null;
  /** Bumped on every jump, so a jump within the open note is noticed too. */
  jumpSeq: number;
  /** Show the note formatted (read mode) instead of the editor (Ctrl+E). */
  readMode: boolean;
  /** Bumped after each save so panels that depend on links refresh. */
  savedSeq: number;
  sidebarTab: SidebarTab;
  editorApi: EditorApi | null;
  /** In-app confirmation waiting for an answer (see ConfirmDialog). */
  confirm: { title: string; message: string; okLabel: string; resolve: (ok: boolean) => void } | null;
  config: VaultConfig;
  /** What this PC's user allowed the open vault to do. */
  trust: DeviceTrust;
  setTrust(t: DeviceTrust): void;
  modal: Modal;
  /** Version viewer (SCR-10): the note and the version to select first. */
  versionView: { path: string; id: number | null } | null;
  /** Folder shown as a table of its notes' properties in place of the editor (FR-PRP-05), or null. */
  tableView: string | null;
  /** PDF shown in place of the editor (FR-ATT-03): its path and the page to go to. `seq` repeats a jump. */
  pdfView: { path: string; page: number; seq: number } | null;
  /** Canvas board (.canvas) shown in place of the editor, or null. */
  canvasView: string | null;
  folderMode: FolderMode;
  /** Note shown beside the current one, in the right pane of the split view (FR-EDT-07), or null. */
  splitPath: string | null;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Back/forward note navigation (Alt+←/→) of the tab on screen. */
  back: string[];
  forward: string[];
  /** Open notes, one tab each (FR-EDT-07). The one on screen is `openPath`. */
  tabs: Tab[];
  /** Recently closed tabs, newest last (Ctrl+Shift+T). */
  closedTabs: ClosedTab[];
  /** Bumped to move focus into the search box (Ctrl+Shift+F). */
  searchFocusSeq: number;
  /** Text to put in the search box on the next focus (a clicked #태그), or null to keep it. */
  searchSeed: string | null;
  /** Bumped to start renaming the open note in its title (F2). */
  titleEditSeq: number;
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
  /** Opens a note in the current tab, or in a new one with `newTab`; an open note's tab is reused. */
  openNote(path: string, line?: number, heading?: string, opts?: OpenOpts): void;
  /**
   * Opens the note a link points at, creating it when it doesn't exist (FR-LNK-02),
   * then goes to `heading` in it. An empty target with a heading means the open note.
   */
  followLink(target: string, heading?: string | null, opts?: OpenOpts): Promise<void>;
  /** Opens a non-note file with its default program (FR-ATT-05). */
  openAttachment(target: string, page?: number): Promise<void>;
  /** Opens a vault file (a note too) with the program Windows uses for its type. */
  openExternal(path: string): Promise<void>;
  /** Shows a PDF in the app at `page` (1-based). */
  openPdf(path: string, page?: number): void;
  closePdf(): void;
  /** Shows a canvas board in place of the editor. */
  openCanvas(path: string): void;
  closeCanvas(): void;
  /** Makes an empty canvas board in `dir` and opens it. */
  createCanvas(dir: string): Promise<void>;
  /** Adds an annotation of a PDF to its "<name> 주석.md" note, making the note if needed. */
  annotatePdf(pdfPath: string, page: number, quote: string, memo: string): Promise<boolean>;
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
  /** Shows a folder in place of the editor, in `mode` or the mode used last. */
  setTableView(folder: string | null, mode?: FolderMode): void;
  /** Sets (or with undefined removes) a frontmatter property, through the editor when the note is open. */
  setNoteProperty(path: string, key: string, value: Prop["value"] | undefined): Promise<void>;
  /**
   * Changes a note's text with `fn` (null = can't), through the editor when the note is open
   * there, else on disk. `failed` is the message shown when `fn` gives up.
   */
  editNote(path: string, fn: (text: string) => string | null, failed: string): Promise<boolean>;
  /** Opens a note in the right pane, beside the current note. */
  openSplit(path: string): void;
  closeSplit(): void;
  setPanels(p: { leftOpen?: boolean; rightOpen?: boolean }): void;
  goBack(): void;
  /** Closes a tab (the one on screen by default). */
  closeTab(path?: string): void;
  closeOtherTabs(path?: string): void;
  stepTab(dir: 1 | -1): void;
  reopenClosedTab(): void;
  setReadMode(on: boolean): void;
  goForward(): void;
  saveConfig(c: VaultConfig): Promise<void>;
  applyPreset(): Promise<void>;
  openTodayJournal(): Promise<void>;
  /** Opens or creates the journal of a day (YYYY-MM-DD). */
  openJournalOn(date: string): Promise<void>;
  /** Collects the week or month around `date` into a review note and opens it (an existing one is just opened). */
  createReview(kind: ReviewKind, date?: Date): Promise<void>;
  /**
   * Copies files dropped from Windows Explorer into `dir` (never over an existing file:
   * a taken name gets a number). `folders` are dropped folders, which are not copied.
   */
  importFiles(dir: string, files: File[], folders?: string[]): Promise<void>;
  /** Backs the vault up to Git now (and syncs with its remote); `quiet` only reports problems. */
  backupNow(quiet?: boolean): Promise<boolean>;
  /** Saves a web page's article as a note in the Inbox and opens it (FR-ATT-03); false if it failed. */
  clipWebPage(url: string): Promise<boolean>;
  /** Folder new notes go to: the open note's folder, else the vault root. */
  currentDir(): string;
  /** Creates a note (optionally from a template); without a name it starts renaming it in the tree. */
  createFromTemplate(dir: string, template: string | null, name?: string): Promise<void>;
  /** Puts a template into the open note at the cursor ("템플릿 삽입"). */
  insertTemplate(template: string): Promise<void>;
  focusSearch(): void;
  /** Shows the search tab filtered by a tag (clicking #태그 in read mode). */
  searchTag(tag: string): void;
  editTitle(): void;
  setQuickOpen(open: boolean): void;
  setDocText(text: string | null): void;
  setEditText(fn: AppStore["editText"]): void;
  createNote(dir: string): Promise<void>;
  createFolder(parent: string, name: string): Promise<void>;
  /** PARA: a project folder with an overview note, which then opens. */
  createProject(name: string): Promise<void>;
  /** Starts naming a new project in the file tree. */
  startNewProject(): void;
  /** PARA: moves a finished or paused note/folder into the archive folder. */
  archive(path: string): Promise<void>;
  /** PARA: moves an archived note/folder back out, into a project, area or resource folder. */
  unarchive(path: string, to: ParaFolder): Promise<void>;
  rename(path: string, newName: string): Promise<void>;
  /** Colors a folder's name in the file tree, and what is inside it; `null` clears it. */
  setFolderColor(path: string, color: string | null): Promise<void>;
  move(path: string, newParent: string): Promise<void>;
  remove(path: string): Promise<void>;
  setEditing(e: Editing | null): void;
  /** Registers how the main editor (or, with `side`, the right pane's) saves; flushEditor saves both. */
  setFlushEditor(fn: (force?: boolean) => Promise<void>, side?: boolean): void;
  toast(message: string, kind?: ToastKind, action?: Toast["action"]): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;
const seenDriveConflicts = new Set<string>();
/** Largest file taken from a drop (as for attachments in the editor). */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
let backingUp = false;

function parentOf(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function baseOf(p: string) {
  return p.slice(p.lastIndexOf("/") + 1);
}
let unlistenChanges: UnlistenFn | null = null;
let treeTimer: number | undefined;
// The two editors' save functions: the main one and the split view's right pane.
let flushMain = async (_force?: boolean) => {};
let flushSide = async (_force?: boolean) => {};
const flushBoth = async (force?: boolean) => {
  await Promise.all([flushMain(force), flushSide(force)]);
};

export const useApp = create<AppStore>((set, get) => {
  /** Tells about conflict copies the drive's app made since the last look. */
  const reportDriveConflicts = async () => {
    if (!get().vault?.drive) return;
    const found = await api.driveConflicts().catch(() => null);
    if (!found) return;
    const fresh = unseenConflicts(found, seenDriveConflicts);
    if (!fresh.length) return;
    const message =
      fresh.length === 1
        ? tx("드라이브가 만든 충돌본이 있습니다: {0}", fresh[0].copy)
        : tx("드라이브가 만든 충돌본이 {0}개 있습니다. 설정 > 백업에서 모두 볼 수 있습니다", fresh.length);
    get().toast(message, "info", { label: tx("열기"), run: () => get().openNote(fresh[0].copy) });
  };

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

  /** Moves or drops (`null`) folder colors whose folder moved or went away. */
  async function recolor(map: (path: string) => string | null) {
    const colors = get().config.folder_colors ?? {};
    const next: Record<string, string> = {};
    for (const [p, c] of Object.entries(colors)) {
      const to = map(p);
      if (to) next[to] = c;
    }
    if (JSON.stringify(next) !== JSON.stringify(colors)) await get().saveConfig({ ...get().config, folder_colors: next });
  }

  async function afterRelocate(from: string, to: string) {
    // Set the new paths before the tree refresh so they aren't reported as deleted.
    if (get().tabs.length || get().openPath) applyTabs(remapTabs(tabState(), (p) => remapPath(p, from, to)));
    // Folders that were open stay open under their new path.
    set({ expanded: new Set([...get().expanded].map((p) => remapPath(p, from, to))) });
    const split = get().splitPath;
    if (split) set({ splitPath: remapPath(split, from, to) });
    const canvas = get().canvasView;
    if (canvas) set({ canvasView: remapPath(canvas, from, to) });
    await recolor((p) => remapPath(p, from, to));
    await get().refreshTree();
    get().noteSaved();
  }

  const tabState = (): Tabs => ({ tabs: get().tabs, active: get().openPath });

  /** Puts a tab state on screen; the shown tab's history drives the back/forward buttons. */
  function applyTabs(next: Tabs, extra: Partial<AppStore> = {}) {
    const cur = next.tabs.find((t) => t.path === next.active);
    // Showing another note closes the table view.
    const other = next.active !== get().openPath;
    const tableView = other ? null : get().tableView;
    const pdfView = other ? null : get().pdfView;
    const canvasView = other ? null : get().canvasView;
    set({ tabs: next.tabs, openPath: next.active, back: cur?.back ?? [], forward: cur?.forward ?? [], tableView, pdfView, canvasView, ...extra });
    if (next.active) expandTo(next.active);
    if (get().vault) void api.setWorkspace(next.active, next.tabs.map((t) => t.path)).catch(() => {});
  }

  /** Remembers tabs about to close, with their place and history, for Ctrl+Shift+T. */
  function rememberClosed(paths: string[]) {
    const { tabs } = get();
    const closed = tabs.flatMap((tab, at) => (paths.includes(tab.path) ? [{ tab, at }] : []));
    if (closed.length) set({ closedTabs: [...get().closedTabs.filter((c) => !paths.includes(c.tab.path)), ...closed].slice(-20) });
  }

  /** Drops tabs of notes `keep` rejects; if the shown note goes, another tab (or none) shows. */
  function dropMissing(keep: (path: string) => boolean): boolean {
    const split = get().splitPath;
    if (split && !keep(split)) set({ splitPath: null });
    const s = tabState();
    if (s.tabs.every((t) => keep(t.path)) && (!s.active || keep(s.active))) return false;
    let next = dropTabs(s, keep);
    if (next.active && !keep(next.active)) next = { ...next, active: next.tabs[0]?.path ?? null };
    applyTabs(next);
    return !!s.active && !keep(s.active);
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
    jumpHeading: null,
    jumpSeq: 0,
    readMode: false,
    savedSeq: 0,
    sidebarTab: "files",
    editorApi: null,
    confirm: null,
    config: DEFAULT_CONFIG,
    trust: NO_TRUST,
    setTrust(trust) {
      set({ trust });
    },
    modal: null,
    versionView: null,
    tableView: null,
    pdfView: null,
    canvasView: null,
    folderMode: "table",
    splitPath: null,
    leftOpen: true,
    rightOpen: true,
    back: [],
    forward: [],
    tabs: [],
    closedTabs: [],
    searchFocusSeq: 0,
    searchSeed: null,
    titleEditSeq: 0,
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
    flushEditor: flushBoth,

    async openVault(path) {
      // Listen before opening: indexing starts with the open and, in a small vault,
      // is done before anything after the open could start listening.
      unlistenChanges?.();
      const changes = await listen<VaultChanged>("vault-changed", ({ payload }) => {
        if (payload.external.length) {
          set({ externalSeq: get().externalSeq + 1, externalPaths: payload.external });
        }
        // Coalesce bursts (e.g. a sync tool writing many files) into one tree refresh.
        window.clearTimeout(treeTimer);
        treeTimer = window.setTimeout(() => {
          void get().refreshTree();
          void reportDriveConflicts();
        }, 150);
      });
      // Indexing runs in the background after opening: reload the note list (link
      // completion, idea board, folder views) once it is done.
      const indexed = await listen("index-ready", () => void (get().vault && get().refreshTree()));
      unlistenChanges = () => {
        changes();
        indexed();
      };

      const info = await attempt(() => api.openVault(path));
      if (!info) return;
      set({ vault: info, trust: NO_TRUST, tree: [], expanded: new Set(), openPath: null, editing: null, back: [], forward: [], tabs: [], closedTabs: [], tableView: null, pdfView: null, canvasView: null, splitPath: null });
      const config = await api.getConfig().catch(() => DEFAULT_CONFIG);
      const trust = await api.deviceTrust().catch(() => NO_TRUST);
      set({ config, trust, sidebarTab: get().sidebarTab === "ideas" && !config.preset_enabled ? "files" : get().sidebarTab });
      if (info.store_warning) {
        get().toast(tx("이전 히스토리를 드라이브 밖으로 옮기지 못했습니다. 원본은 .app 폴더에 그대로 있고, 다음에 열 때 다시 시도합니다: {0}", info.store_warning), "error");
      }
      seenDriveConflicts.clear();
      void reportDriveConflicts();
      applyTheme(config.theme);
      await get().refreshTree();

      // Reopen the tabs and the note that were open last time (FR-VLT-02).
      const ws = await api.getWorkspace().catch(() => null);
      const exists = (p: string) => !!findNode(get().tree, p);
      const saved = (ws?.tabs ?? []).filter(exists);
      if (saved.length) set({ tabs: saved.map((path) => ({ path, back: [], forward: [] })) });
      const last = ws?.open_path && exists(ws.open_path) ? ws.open_path : saved[0];
      if (last) get().openNote(last);

      // The history policy (FR-HIS-08) is applied each time the vault opens.
      if (config.history_thin_days || config.history_delete_days) void api.pruneHistory(false).catch(() => {});
    },

    async closeVault() {
      await get().flushEditor();
      unlistenChanges?.();
      unlistenChanges = null;
      await attempt(() => api.closeVault());
      set({ vault: null, trust: NO_TRUST, tree: [], openPath: null, editing: null, tabs: [], back: [], forward: [] });
    },

    async refreshTree() {
      const [tree, notes] = await Promise.all([attempt(() => api.listTree()), api.listNotes().catch(() => null)]);
      if (notes) set({ notes });
      if (!tree) return;
      set({ tree });
      const canvas = get().canvasView;
      if (canvas && !findNode(tree, canvas)) set({ canvasView: null });
      if (dropMissing((p) => !!findNode(tree, p))) get().toast(tx("열려 있던 노트가 다른 프로그램에서 삭제되거나 이동되었습니다"));
    },

    toggleFolder(path, open) {
      const expanded = new Set(get().expanded);
      const next = open ?? !expanded.has(path);
      if (next) expanded.add(path);
      else expanded.delete(path);
      set({ expanded });
    },

    openNote(path, line, heading, opts) {
      void get().flushEditor();
      applyTabs(openTab(tabState(), path, !!opts?.newTab), {
        tableView: null,
        pdfView: null,
        canvasView: null,
        jumpLine: line ?? null,
        jumpHeading: heading ?? null,
        jumpSeq: line ? get().jumpSeq + 1 : get().jumpSeq,
        recent: [path, ...get().recent.filter((p) => p !== path)].slice(0, 30),
      });
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

    async createProject(name) {
      const path = await attempt(() => api.createProject(name));
      if (!path) return;
      await get().refreshTree();
      get().openNote(path);
    },

    startNewProject() {
      const parent = get().config.project_folder;
      get().toggleFolder(parent, true);
      set({ editing: { mode: "new-folder", parent, project: true }, sidebarTab: "files", leftOpen: true });
    },

    async archive(path) {
      await get().move(path, get().config.archive_folder);
    },

    async unarchive(path, to) {
      await get().move(path, get().config[to]);
    },

    openPdf(path, page = 1) {
      void get().flushEditor();
      set({ pdfView: { path, page, seq: (get().pdfView?.seq ?? 0) + 1 }, tableView: null, canvasView: null });
    },

    closePdf() {
      set({ pdfView: null });
    },

    async openExternal(path) {
      try {
        // A link's words are the note writer's, so "회의록 보기" may be 회의록.bat.
        if (
          !opensWithoutAsking(path) &&
          !(await get().ask(
            tx("이 파일을 열까요?"),
            tx("{0}\n\n이 형식의 파일은 프로그램이 실행될 수 있습니다. 만든 사람을 믿을 수 있을 때만 여세요.", path),
            tx("열기"),
          ))
        ) {
          return;
        }
        // Unsaved edits of an open note go to disk before another program reads it.
        if (path === get().openPath || path === get().splitPath) await get().flushEditor();
        await openWithOs(await api.attachmentPath(path));
      } catch (e) {
        get().toast(tx("파일을 열지 못했습니다: {0}", errorMessage(e)), "error");
      }
    },

    openCanvas(path) {
      void get().flushEditor();
      set({ canvasView: path, pdfView: null, tableView: null });
    },

    closeCanvas() {
      set({ canvasView: null });
    },

    async createCanvas(dir) {
      const path = await attempt(() => api.createCanvas(dir));
      if (!path) return;
      await get().refreshTree();
      expandTo(path);
      get().openCanvas(path);
      // Name it inline in the file tree, like a new note.
      set({ editing: { mode: "rename", path }, sidebarTab: "files", leftOpen: true });
    },

    async annotatePdf(pdfPath, page, quote, memo) {
      const path = annotationPath(pdfPath);
      const entry = annotationEntry(pdfPath, page, quote, memo);
      if (findNode(get().tree, path)) {
        return get().editNote(path, (t) => t.replace(/\s*$/, "\n") + entry, tx("주석을 넣지 못했습니다"));
      }
      const slash = path.lastIndexOf("/");
      const created = await attempt(() =>
        api.createNote(slash < 0 ? "" : path.slice(0, slash), path.slice(slash + 1), annotationNote(pdfPath, day(Date.now())) + entry),
      );
      if (!created) return false;
      await get().refreshTree();
      get().noteSaved();
      return true;
    },

    async openAttachment(target, page) {
      const rel = await api.resolveAttachment(target, get().openPath ?? "").catch(() => null);
      const folder = get().config.attachment_folder;
      if (!rel) {
        get().toast(tx("첨부 파일을 찾을 수 없음: {0}", target), "error", {
          label: tx("폴더 열기"),
          run: () => {
            const root = get().vault?.root;
            if (root) void revealItemInDir(`${root}\\${folder.replace(/\//g, "\\")}`).catch(() => {});
          },
        });
        return;
      }
      if (/\.pdf$/i.test(rel)) return get().openPdf(rel, page);
      if (/\.canvas$/i.test(rel)) return get().openCanvas(rel);
      return get().openExternal(rel);
    },

    async followLink(target, heading, opts) {
      // [[견적서.xlsx]] and other non-note files open in their own program.
      // [[문서.pdf#page=3]] opens the PDF at that page.
      if (/\.[a-z0-9]{1,8}$/i.test(target) && !/\.md$/i.test(target)) {
        const page = /^page=(\d+)$/i.exec(heading ?? "");
        return get().openAttachment(target, page ? Number(page[1]) : undefined);
      }
      const found = target ? await attempt(() => api.resolveLink(target)) : get().openPath;
      if (found === undefined) return;
      if (found && heading) {
        // Read the saved text, so flush the editor first when the heading is in the open note.
        if (found === get().openPath) await get().flushEditor();
        const text = await attempt(() => api.readNote(found));
        // [[노트#^id]] points at a block, [[노트#제목]] at a heading.
        const block = heading.startsWith("^");
        const line = text === undefined ? null : block ? findBlockLine(text, heading) : findHeadingLine(text, heading);
        if (line === null) get().toast((block ? tx("'{0}' 블록을 찾지 못해 노트 처음을 엽니다", heading) : tx("'{0}' 제목을 찾지 못해 노트 처음을 엽니다", heading)));
        return get().openNote(found, line ?? undefined, line === null ? undefined : heading, opts);
      }
      if (found) return get().openNote(found, undefined, undefined, opts);
      if (!target) return;
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
      get().openNote(created, undefined, undefined, opts);
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

    openSplit(path) {
      void flushSide();
      set({ splitPath: path });
    },

    closeSplit() {
      set({ splitPath: null });
    },

    setTableView(tableView, mode) {
      if (tableView !== null) void get().flushEditor();
      set(mode ? { tableView, folderMode: mode, pdfView: null, canvasView: null } : { tableView, pdfView: null, canvasView: null });
    },

    async setNoteProperty(path, key, value) {
      await get().editNote(path, (t) => setProperty(t, key, value), tx("속성 YAML에 오류가 있어 속성을 바꾸지 못했습니다"));
    },

    async editNote(path, fn, failed) {
      if (get().openPath === path && get().editorApi) {
        if (get().editText(fn)) return true;
        get().toast(failed, "error");
        return false;
      }
      try {
        // The right pane may hold unsaved edits of this note.
        await get().flushEditor();
        const next = fn(await api.readNote(path));
        if (next === null) {
          get().toast(failed, "error");
          return false;
        }
        const out = await api.writeNote(path, next, true);
        if (out.conflict) get().toast(tx("다른 프로그램이 동시에 고쳐서 \"{0}\"로 따로 저장했습니다", out.conflict), "error");
        get().noteSaved();
        return true;
      } catch (e) {
        get().toast(tx("노트를 고치지 못했습니다: {0}", errorMessage(e)), "error");
        return false;
      }
    },

    setPanels(p) {
      set(p);
    },

    goBack() {
      // A PDF or canvas shown over the note: back is the note.
      if (get().pdfView || get().canvasView) return set({ pdfView: null, canvasView: null });
      const next = goHistory(tabState(), -1, (p) => !!findNode(get().tree, p));
      if (!next) return;
      void get().flushEditor();
      applyTabs(next, { jumpLine: null });
    },

    closeTab(path = get().openPath ?? undefined) {
      if (!path || !get().tabs.some((t) => t.path === path)) return;
      if (path === get().openPath) void get().flushEditor();
      rememberClosed([path]);
      applyTabs(closeTab(tabState(), path), { jumpLine: null });
    },

    closeOtherTabs(path = get().openPath ?? undefined) {
      if (!path) return;
      rememberClosed(get().tabs.map((t) => t.path).filter((p) => p !== path));
      if (path !== get().openPath) void get().flushEditor();
      applyTabs(closeOtherTabs(tabState(), path), { jumpLine: null });
    },

    stepTab(dir) {
      const next = stepTab(tabState(), dir);
      if (next.active === get().openPath) return;
      void get().flushEditor();
      applyTabs(next, { jumpLine: null });
    },

    reopenClosedTab() {
      const { closedTabs, tabs, tree } = get();
      const open = new Set(tabs.map((t) => t.path));
      const closed = [...closedTabs].reverse().find((c) => !open.has(c.tab.path) && findNode(tree, c.tab.path));
      set({ closedTabs: closed ? closedTabs.filter((c) => c !== closed) : [] });
      if (!closed) return;
      void get().flushEditor();
      applyTabs(reopenTab(tabState(), closed), { jumpLine: null });
    },

    goForward() {
      const next = goHistory(tabState(), 1, (p) => !!findNode(get().tree, p));
      if (!next) return;
      void get().flushEditor();
      applyTabs(next, { jumpLine: null });
    },

    async saveConfig(config) {
      const ok = await attempt(() => api.setConfig(config).then(() => true));
      if (!ok) return;
      set({ config });
      applyTheme(config.theme);
    },

    async applyPreset() {
      const c = get().config;
      // PARA (Projects·Areas·Resources·Archives), the app's folders inside them, then the rest.
      const folders = [
        tx("{0}  — 정리 전 메모", c.inbox_folder),
        tx("{0}  — 프로젝트: 끝과 목표가 있는 일", c.project_folder),
        tx("{0}  — 영역: 계속 맡아 챙기는 일", c.area_folder),
        tx("{0}  — 자료: 관심 주제·참고 자료", c.resource_folder),
        `   ${c.idea_folder}`,
        `   ${c.research_folder}`,
        tx("{0}  — 보관: 끝났거나 쉬는 것", c.archive_folder),
        c.template_folder,
        c.attachment_folder,
      ];
      const ok = await get().ask(
        tx("기본 구조 만들기 (PARA)"),
        tx("노트 폴더에 PARA 방식의 폴더와 템플릿 5개(프로젝트·업무일지·회의록·아이디어·자료)를 만들고, 폴더마다 무엇을 넣는지 적은 '_안내' 노트를 넣습니다.\n\n{0}\n\n이미 있는 폴더와 노트는 바꾸지 않습니다.", folders.join("\n")),
        tx("켜기"),
      );
      if (!ok) return;
      const r = await attempt(() => api.applyPreset());
      if (!r) return;
      const config = await api.getConfig().catch(() => get().config);
      set({ config });
      await get().refreshTree();
      const made = r.created_folders.length + r.created_templates.length + r.created_guides.length;
      get().toast(
        made
          ? tx("기본 구조를 만들었습니다 · 폴더 {0}개, 템플릿 {1}개, 안내 노트 {2}개", r.created_folders.length, r.created_templates.length, r.created_guides.length)
          : tx("기본 구조를 켰습니다 · 이미 있는 폴더와 템플릿은 그대로 두었습니다"),
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

    async createReview(kind, date = new Date()) {
      const config = get().config;
      const p = period(kind, date);
      const folder = reviewFolder(config);
      const name = reviewName(kind, p);
      const path = `${folder}/${name}.md`;
      if (get().notes.some((n) => n.path.toLowerCase() === path.toLowerCase())) {
        get().openNote(path);
        get().toast(tx("이미 만든 회고를 엽니다 · 다시 만들려면 이 노트를 지우고 실행하세요"));
        return;
      }
      const table = await attempt(() => api.folderTable(""));
      if (!table) return;
      const content = buildReview(kind, p, table.rows, config, day(Date.now()));
      const created = await attempt(() => api.createNote(folder, name, content));
      if (!created) return;
      await get().refreshTree();
      get().openNote(created);
    },

    async importFiles(dir, files, folders = []) {
      const saved: string[] = [];
      for (const f of files) {
        if (f.size > MAX_IMPORT_BYTES) {
          get().toast(tx("\"{0}\"은(는) 50MB가 넘어 넣지 않았습니다", f.name), "error");
          continue;
        }
        try {
          saved.push(await api.saveAttachment(f.name, new Uint8Array(await f.arrayBuffer()), dir));
        } catch (e) {
          get().toast(tx("\"{0}\"을(를) 넣지 못했습니다: {1}", f.name, errorMessage(e)), "error");
        }
      }
      if (folders.length) get().toast(tx("폴더는 넣을 수 없습니다: {0} · 폴더 안의 파일을 골라 끌어다 놓으세요", folders.join(", ")), "error");
      if (!saved.length) return;
      await get().refreshTree();
      if (dir) expandTo(dir + "/");
      const where = dir || tx("노트 폴더 맨 위");
      get().toast(
        saved.length === 1 ? tx("\"{0}\"을(를) {1}에 넣었습니다", saved[0].split("/").pop(), where) : tx("파일 {0}개를 {1}에 넣었습니다", saved.length, where),
      );
    },

    async backupNow(quiet = false) {
      if (backingUp) return false;
      backingUp = true;
      try {
        await get().flushEditor();
        const r = await api.backupNow(tx("Notevine 백업 {0}", new Date().toLocaleString(dateLocale())));
        if (r.pulled) await get().refreshTree();
        if (!quiet || r.pulled) {
          const parts = [
            r.committed ? tx("노트 {0}개 변경을 저장", r.files) : tx("바뀐 노트 없음"),
            ...(r.pulled ? [tx("다른 PC의 변경을 받음")] : []),
            ...(r.pushed ? [tx("원격 저장소로 보냄")] : []),
          ];
          get().toast(tx("백업했습니다 · {0}", parts.join(" · ")));
        }
        return true;
      } catch (e) {
        get().toast(tx("백업하지 못했습니다: {0}", errorMessage(e)), "error");
        return false;
      } finally {
        backingUp = false;
      }
    },

    async clipWebPage(url) {
      const config = get().config;
      let page: { url: string; html: string };
      try {
        page = await api.fetchPage(url);
      } catch (e) {
        get().toast(errorMessage(e), "error");
        return false;
      }
      // Loaded here: its article extractor and HTML converter are only needed for clipping.
      const { clipFileName, clipNote, clipPage } = await import("./lib/clip");
      const clip = clipPage(page.html, page.url);
      if (!clip) {
        get().toast(tx("이 페이지에서 본문을 찾지 못했습니다"), "error");
        return false;
      }
      const folder = config.preset_enabled ? config.inbox_folder : "";
      const content = clipNote(clip, page.url, day(Date.now()));
      const base = clipFileName(clip.title);
      // Same title clipped again: "제목 2", "제목 3"…
      for (let n = 1; n <= 50; n++) {
        try {
          const created = await api.createNote(folder, n === 1 ? base : `${base} ${n}`, content);
          await get().refreshTree();
          get().openNote(created);
          get().toast(tx("웹 페이지를 노트로 저장했습니다 · {0}", created));
          return true;
        } catch (e) {
          if ((e as AppError)?.code !== "already_exists") {
            get().toast(errorMessage(e), "error");
            return false;
          }
        }
      }
      get().toast(tx("같은 이름의 노트가 너무 많습니다"), "error");
      return false;
    },

    async openJournalOn(date) {
      if (!get().config.preset_enabled) {
        await get().applyPreset();
        if (!get().config.preset_enabled) return;
      }
      const path = await attempt(() => api.openJournalOn(date));
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

    async insertTemplate(template) {
      const path = get().openPath;
      if (!path) return;
      const title = (path.split("/").pop() ?? "").replace(/\.md$/i, "");
      const text = await attempt(() => api.renderTemplate(template, title));
      const ed = get().editorApi;
      // Another note may have opened while the template was read.
      if (text === undefined || !ed || get().openPath !== path) return;
      if (get().readMode) set({ readMode: false });
      ed.rewrite((cur, cursor) => insertTemplate(cur, cursor, text));
    },

    focusSearch() {
      set({ sidebarTab: "search", searchFocusSeq: get().searchFocusSeq + 1 });
    },

    searchTag(tag) {
      set({ leftOpen: true, sidebarTab: "search", searchSeed: `#${tag}`, searchFocusSeq: get().searchFocusSeq + 1 });
    },

    editTitle() {
      set({ titleEditSeq: get().titleEditSeq + 1 });
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

    async setFolderColor(path, color) {
      const { [path]: _old, ...rest } = get().config.folder_colors ?? {};
      await get().saveConfig({ ...get().config, folder_colors: color ? { ...rest, [path]: color } : rest });
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
      // The deleted note (or everything in the deleted folder) leaves its tabs.
      dropMissing((p) => remapPath(p, path, "\0") === p);
      await recolor((p) => (remapPath(p, path, "\0") === p ? p : null));
      await get().refreshTree();
      get().toast(tx("휴지통으로 옮겼습니다"));
    },

    setFlushEditor(fn, side) {
      if (side) flushSide = fn;
      else flushMain = fn;
      set({ flushEditor: flushBoth });
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
