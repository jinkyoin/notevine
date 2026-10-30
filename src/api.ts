// Typed wrappers for the Tauri commands in src-tauri/src/commands.rs.
// Keep names and argument shapes in sync with the Rust side.
import { Channel, invoke } from "@tauri-apps/api/core";

export type EntryKind = "folder" | "note" | "file";

export interface TreeNode {
  path: string; // vault-relative, "/" separators
  name: string;
  kind: EntryKind;
  mtime: number; // ms since epoch
  children?: TreeNode[];
}

export interface VaultInfo {
  root: string;
  name: string;
}

export interface RecentVault {
  path: string;
  name: string;
  opened_at: number;
  exists: boolean;
}

export interface VersionMeta {
  id: number;
  path: string;
  started_at: number;
  saved_at: number;
  size: number;
  origin: "app" | "external" | "restore";
}

export interface SaveOutcome {
  /** Saved, but the history snapshot or index update failed. */
  warning: string | null;
  /** Another program changed the file; the editor's text was saved to this path instead. */
  conflict: string | null;
}

export interface VaultChanged {
  changed: string[];
  external: string[];
}

export interface NoteRef {
  path: string;
  title: string;
}

export interface Backlink {
  path: string;
  title: string;
  line: number;
  context: string;
}

/** A note whose links a rename/move would rewrite. */
export interface LinkChange {
  path: string;
  title: string;
  count: number;
}

export interface PropFilter {
  key: string;
  op: "eq" | "ne" | "contains" | "empty";
  value: string | null;
}

export interface DateFilter {
  field: "created" | "modified";
  from: number | null;
  to: number | null;
}

export interface SearchQuery {
  text: string[];
  tags: string[];
  props: PropFilter[];
  date?: DateFilter | null;
  limit?: number;
}

export interface SearchHit {
  path: string;
  title: string;
  mtime: number;
  parts: { text: string; hit: boolean }[];
  line: number | null;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  took_ms: number;
}

export interface VaultConfig {
  preset_enabled: boolean;
  inbox_folder: string;
  journal_folder: string;
  idea_folder: string;
  research_folder: string;
  template_folder: string;
  attachment_folder: string;
  journal_path: string;
  idea_statuses: string[];
  link_click: "ctrl" | "click";
  update_links_on_rename: boolean;
  autosave_ms: number;
  theme: "system" | "light" | "dark";
  language: "ko" | "en";
  /** Folder path → color of its name in the file tree; what is inside takes it too. */
  folder_colors: Record<string, string>;
}

export interface PresetResult {
  created_folders: string[];
  created_templates: string[];
  skipped: string[];
}

export interface TemplateRef {
  path: string;
  title: string;
  preview: string;
  folder: string | null;
}

export interface IdeaItem {
  path: string;
  title: string;
  status: string;
  mtime: number;
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
  old_no: number | null;
  new_no: number | null;
}

export interface DeletedNote {
  path: string;
  title: string;
  last_saved_at: number;
  versions: number;
}

export interface AiProvider {
  id: "claude" | "codex";
  name: string;
  available: boolean;
  version: string | null;
  logged_in: boolean | null;
  detail: string | null;
}

export interface ContextNote {
  path: string;
  title: string;
  snippet: string;
  chars: number;
}

export type AiEvent =
  | { kind: "started"; model: string | null }
  | { kind: "delta"; text: string }
  | { kind: "notice"; message: string }
  | { kind: "progress"; message: string }
  | { kind: "done"; text: string; cost_usd: number | null }
  | { kind: "error"; message: string };

export interface AppError {
  code: string;
  message: string;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as AppError).message);
  return String(e);
}

export const api = {
  openVault: (path: string) => invoke<VaultInfo>("open_vault", { path }),
  closeVault: () => invoke<void>("close_vault"),
  recentVaults: () => invoke<RecentVault[]>("recent_vaults"),
  forgetVault: (path: string) => invoke<void>("forget_vault", { path }),
  listTree: () => invoke<TreeNode[]>("list_tree"),
  readNote: (path: string) => invoke<string>("read_note", { path }),
  writeNote: (path: string, content: string, force = false) =>
    invoke<SaveOutcome>("write_note", { path, content, force }),
  getWorkspace: () => invoke<{ open_path: string | null; tabs?: string[] }>("get_workspace"),
  setWorkspace: (openPath: string | null, tabs: string[]) => invoke<void>("set_workspace", { openPath, tabs }),
  listVersions: (path: string) => invoke<VersionMeta[]>("list_versions", { path }),
  versionContent: (id: number) => invoke<string>("version_content", { id }),
  createNote: (dir: string, name?: string, content?: string) =>
    invoke<string>("create_note", { dir, name: name ?? null, content: content ?? null }),
  createFolder: (parent: string, name: string) => invoke<string>("create_folder", { parent, name }),
  renameEntry: (path: string, newName: string, updateLinks = true) =>
    invoke<string>("rename_entry", { path, newName, updateLinks }),
  moveEntry: (path: string, newParent: string, updateLinks = true) =>
    invoke<string>("move_entry", { path, newParent, updateLinks }),
  previewRename: (path: string, newName: string) => invoke<LinkChange[]>("preview_rename", { path, newName }),
  previewMove: (path: string, newParent: string) => invoke<LinkChange[]>("preview_move", { path, newParent }),
  listNotes: () => invoke<NoteRef[]>("list_notes"),
  rebuildIndex: () => invoke<number>("rebuild_index"),
  resolveLink: (target: string) => invoke<string | null>("resolve_link", { target }),
  backlinks: (path: string) => invoke<Backlink[]>("backlinks", { path }),
  search: (query: SearchQuery) => invoke<SearchResult>("search", { query }),
  propertyKeys: () => invoke<string[]>("property_keys"),
  propertyValues: (key: string) => invoke<string[]>("property_values", { key }),
  allTags: () => invoke<{ tag: string; count: number }[]>("all_tags"),
  getConfig: () => invoke<VaultConfig>("get_config"),
  setConfig: (config: VaultConfig) => invoke<void>("set_config", { config }),
  applyPreset: () => invoke<PresetResult>("apply_preset"),
  listTemplates: () => invoke<TemplateRef[]>("list_templates"),
  createFromTemplate: (dir: string, name: string | null, template: string | null) =>
    invoke<string>("create_from_template", { dir, name, template }),
  /** A template's text with its variables filled in for a note named `title`. */
  renderTemplate: (template: string, title: string) => invoke<string>("render_template_text", { template, title }),
  openTodayJournal: () => invoke<string>("open_today_journal"),
  quickMemo: (text: string, title: string | null) => invoke<string>("quick_memo", { text, title }),
  ideas: () => invoke<IdeaItem[]>("ideas"),
  restoreVersion: (path: string, id: number) => invoke<void>("restore_version", { path, id }),
  versionDiff: (path: string, fromId: number | null, toId: number | null) =>
    invoke<DiffLine[]>("version_diff", { path, fromId, toId }),
  deletedNotes: () => invoke<DeletedNote[]>("deleted_notes"),
  importAttachment: (src: string, folder: string) => invoke<string>("import_attachment", { src, folder }),
  saveAttachment: (name: string, data: Uint8Array, folder: string) =>
    invoke<string>("save_attachment", { name, data: Array.from(data), folder }),
  resolveAttachment: (target: string, from: string) => invoke<string | null>("resolve_attachment", { target, from }),
  attachmentPath: (path: string) => invoke<string>("attachment_path", { path }),
  /** `refresh` probes the CLIs again instead of using the minute-long cache. */
  aiProviders: (refresh = false) => invoke<AiProvider[]>("ai_providers", { refresh }),
  /** Opens the CLI's own login window; resolves with the provider's state once it closes. */
  aiLogin: (provider: string) => invoke<AiProvider>("ai_login", { provider }),
  aiContext: (question: string, limit = 8) =>
    invoke<{ notes: ContextNote[]; private_excluded: string[] }>("ai_context", { question, limit }),
  /** The given notes that carry #비공개 (never sent to AI). */
  aiPrivateNotes: (paths: string[]) => invoke<string[]>("ai_private_notes", { paths }),
  /** Starts an AI run; events arrive on `onEvent`. Resolves once the CLI has been started. */
  aiRun: (
    requestId: string,
    provider: string,
    system: string,
    prompt: string,
    notes: string[],
    model: string | null,
    web: boolean,
    onEvent: (e: AiEvent) => void,
  ) => {
    const ch = new Channel<AiEvent>();
    ch.onmessage = onEvent;
    return invoke<void>("ai_run", { requestId, provider, system, prompt, notes, model, web, onEvent: ch });
  },
  aiCancel: (requestId: string) => invoke<boolean>("ai_cancel", { requestId }),
  deleteEntry: (path: string) => invoke<void>("delete_entry", { path }),
  revealEntry: (path: string) => invoke<string>("reveal_entry", { path }),
};
