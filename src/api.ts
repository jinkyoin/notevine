// Typed wrappers for the Tauri commands in src-tauri/src/commands.rs.
// Keep names and argument shapes in sync with the Rust side.
import { invoke } from "@tauri-apps/api/core";

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
  getWorkspace: () => invoke<{ open_path: string | null }>("get_workspace"),
  setWorkspace: (openPath: string | null) => invoke<void>("set_workspace", { openPath }),
  listVersions: (path: string) => invoke<VersionMeta[]>("list_versions", { path }),
  versionContent: (id: number) => invoke<string>("version_content", { id }),
  createNote: (dir: string, name?: string, content?: string) =>
    invoke<string>("create_note", { dir, name: name ?? null, content: content ?? null }),
  createFolder: (parent: string, name: string) => invoke<string>("create_folder", { parent, name }),
  renameEntry: (path: string, newName: string) => invoke<string>("rename_entry", { path, newName }),
  moveEntry: (path: string, newParent: string) => invoke<string>("move_entry", { path, newParent }),
  deleteEntry: (path: string) => invoke<void>("delete_entry", { path }),
  revealEntry: (path: string) => invoke<string>("reveal_entry", { path }),
};
