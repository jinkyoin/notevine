// Typed wrappers for the Tauri commands in src-tauri/src/commands.rs.
// Keep names and argument shapes in sync with the Rust side.
import { Channel, invoke } from "@tauri-apps/api/core";
import { tx } from "./i18n";

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

/** A folder's notes with their properties (FR-PRP-05). */
export interface FolderTable {
  /** Property keys, the most used first. */
  columns: string[];
  rows: { path: string; title: string; mtime: number; props: Record<string, string> }[];
}

/** Notes of a folder and the links between them; edges index into `nodes`. */
export interface LinkGraph {
  nodes: { path: string; title: string }[];
  edges: [number, number][];
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
  /** PARA (Tiago Forte): Projects, Areas, Resources, Archives. */
  project_folder: string;
  area_folder: string;
  resource_folder: string;
  archive_folder: string;
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
  /** Named searches shown in the search panel (FR-SRC-06). */
  saved_searches: SavedSearch[];
  /** History older than this many days keeps one version per note per day; 0 = off (FR-HIS-08). */
  history_thin_days: number;
  /** History older than this many days is removed (each note's newest stays); 0 = off. */
  history_delete_days: number;
  /** Command id → shortcut ("" = none) replacing the built-in one (FR-UI-05). */
  keybindings: Record<string, string>;
}

/** What this PC's user allowed the open vault to do; kept outside the vault, which can't grant it. */
export interface DeviceTrust {
  /** Git may run in the vault's existing `.git`. */
  git: boolean;
  /** Back up to Git every this many minutes when something changed; 0 = only by hand. */
  backup_minutes: number;
  /** Apply `.app/custom.css` on top of the app's styles (FR-UI-05). */
  custom_css: boolean;
}

/** The vault as a Git repository (backup). */
export interface BackupStatus {
  git: boolean;
  repo: boolean;
  /** The user allowed Git to run in it on this PC; until then the rest stays empty. */
  trusted: boolean;
  branch: string | null;
  remote: string | null;
  changed: number;
  ahead: number;
  behind: number;
  last_at: number | null;
  last_message: string | null;
}

export interface BackupResult {
  committed: boolean;
  files: number;
  pushed: boolean;
  pulled: boolean;
}

export type PluginPermission = "read" | "write" | "network";

/** A folder in `.app/plugins`; `error` says why it can't be used. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: PluginPermission[];
  error: string | null;
  /** The permissions it runs with; null = off. */
  granted: PluginPermission[] | null;
  /** It was on, but its code or manifest changed since: needs turning on again. */
  changed: boolean;
}

/** App-wide settings (not per vault). */
export interface AppSettings {
  /** Closing the window keeps Notevine in the tray. */
  tray: boolean;
  /** Ollama's address on this PC; "" = http://127.0.0.1:11434. */
  ollama_url: string;
  /** Windows starts Notevine (into the tray) at sign-in. */
  autostart: boolean;
  /** Look for a new version at start-up; off until the user turns it on. */
  update_check: boolean;
}

export interface HistoryStats {
  versions: number;
  notes: number;
  stored_bytes: number;
  file_bytes: number;
  oldest: number | null;
}

export interface SavedSearch {
  name: string;
  /** Search box text, in its syntax (#태그 status:검토 ...). */
  text: string;
  /** Conditions added with ＋ 조건. */
  filters: PropFilter[];
  date_field: DateFilter["field"];
  range: "all" | "today" | "7d" | "30d";
}

export interface PresetResult {
  created_folders: string[];
  created_templates: string[];
  /** "_안내.md" notes that explain each PARA folder. */
  created_guides: string[];
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
  id: "claude" | "codex" | "anthropic" | "openai" | "ollama";
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

/** Backend errors whose wording the screen language decides; the detail after ": " is kept. */
const ERROR_TEXT: Record<string, () => string> = {
  no_vault: () => tx("노트 폴더가 열려 있지 않습니다"),
  not_a_directory: () => tx("폴더를 찾을 수 없습니다"),
  not_found: () => tx("파일이나 폴더를 찾을 수 없습니다"),
  already_exists: () => tx("같은 이름이 이미 있습니다"),
  invalid_name: () => tx("사용할 수 없는 이름입니다"),
  outside_vault: () => tx("노트 폴더 밖의 경로는 사용할 수 없습니다"),
  trash: () => tx("휴지통으로 옮기지 못했습니다"),
};

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const { code, message } = e as AppError;
    const text = ERROR_TEXT[code];
    if (!text) return String(message);
    const at = String(message).indexOf(": ");
    return at < 0 ? text() : `${text()}: ${String(message).slice(at + 2)}`;
  }
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
  historyStats: () => invoke<HistoryStats>("history_stats"),
  /** Applies the history policy; `dryRun` only counts. Returns versions removed. */
  pruneHistory: (dryRun: boolean) => invoke<number>("prune_history", { dryRun }),
  /** [path, text] of `.app/custom.css`; `create` makes a missing one with a short guide. */
  appSettings: () => invoke<AppSettings>("app_settings"),
  /** Downloads a web page (http/https only) for clipping; `url` is where it ended up. */
  fetchPage: (url: string) => invoke<{ url: string; html: string }>("fetch_page", { url }),
  setTray: (on: boolean) => invoke<void>("set_tray", { on }),
  setAutostart: (on: boolean) => invoke<void>("set_autostart", { on }),
  setUpdateCheck: (on: boolean) => invoke<void>("set_update_check", { on }),
  customCss: (create: boolean) => invoke<[string, string]>("custom_css", { create }),
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
  folderTable: (folder: string) => invoke<FolderTable>("folder_table", { folder }),
  linkGraph: (folder: string) => invoke<LinkGraph>("link_graph", { folder }),
  propertyValues: (key: string) => invoke<string[]>("property_values", { key }),
  allTags: () => invoke<{ tag: string; count: number }[]>("all_tags"),
  noteTags: (path: string) => invoke<string[]>("note_tags", { path }),
  getConfig: () => invoke<VaultConfig>("get_config"),
  setConfig: (config: VaultConfig) => invoke<void>("set_config", { config }),
  applyPreset: () => invoke<PresetResult>("apply_preset"),
  listTemplates: () => invoke<TemplateRef[]>("list_templates"),
  createFromTemplate: (dir: string, name: string | null, template: string | null) =>
    invoke<string>("create_from_template", { dir, name, template }),
  /** A template's text with its variables filled in for a note named `title`. */
  renderTemplate: (template: string, title: string) => invoke<string>("render_template_text", { template, title }),
  openTodayJournal: () => invoke<string>("open_today_journal"),
  /** The journal of a day (YYYY-MM-DD), created from the template when missing. */
  openJournalOn: (date: string) => invoke<string>("open_journal_on", { date }),
  quickMemo: (text: string, title: string | null) => invoke<string>("quick_memo", { text, title }),
  /** PARA project folder + overview note; returns the note's path. */
  createProject: (name: string) => invoke<string>("create_project", { name }),
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
  /** Saves an API key in the Windows Credential Manager; "" removes it (FR-AI-07). */
  aiSetKey: (provider: string, key: string) => invoke<void>("ai_set_key", { provider, key }),
  /** Models an API provider or Ollama offers. */
  aiModels: (provider: string) => invoke<string[]>("ai_models", { provider }),
  setOllamaUrl: (url: string) => invoke<void>("set_ollama_url", { url }),
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
  /** Makes an empty `.canvas` board in `dir`; returns its path. */
  createCanvas: (dir: string, name?: string) => invoke<string>("create_canvas", { dir, name: name ?? null }),
  saveCanvas: (path: string, content: string) => invoke<void>("save_canvas", { path, content }),
  deviceTrust: () => invoke<DeviceTrust>("device_trust"),
  setBackupMinutes: (minutes: number) => invoke<DeviceTrust>("set_backup_minutes", { minutes }),
  setCustomCss: (on: boolean) => invoke<DeviceTrust>("set_custom_css", { on }),
  backupStatus: () => invoke<BackupStatus>("backup_status"),
  /** Allows Git in the `.git` that was already in this folder. */
  backupTrust: () => invoke<BackupStatus>("backup_trust"),
  backupInit: () => invoke<void>("backup_init"),
  /** "" removes the remote. */
  backupSetRemote: (url: string) => invoke<void>("backup_set_remote", { url }),
  backupNow: (message: string) => invoke<BackupResult>("backup_now", { message }),
  listPlugins: () => invoke<PluginInfo[]>("list_plugins"),
  pluginSource: (id: string) => invoke<string>("plugin_source", { id }),
  /** Turns a plugin on, for its code as it is now, or off. */
  setPluginGrant: (id: string, on: boolean) => invoke<void>("set_plugin_grant", { id, on }),
  /** `.app/plugins` as an absolute path (made if missing). */
  pluginsFolder: () => invoke<string>("plugins_folder"),
  /** Puts the sample plugin in `.app/plugins`; returns its id. */
  createSamplePlugin: () => invoke<string>("create_sample_plugin"),
  deleteEntry: (path: string) => invoke<void>("delete_entry", { path }),
  revealEntry: (path: string) => invoke<string>("reveal_entry", { path }),
};
