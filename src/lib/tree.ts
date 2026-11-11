import type { TreeNode } from "../api";

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Note title shown in the UI: file name without `.md`. */
export function noteTitle(path: string): string {
  return baseName(path).replace(/\.md$/i, "");
}

export function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children && path.startsWith(n.path + "/")) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Number of notes under a folder, recursively. */
export function countNotes(node: TreeNode): number {
  if (node.kind === "note") return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countNotes(c), 0);
}

/** Every ancestor folder of `path`, outermost first ("a/b/c.md" → ["a", "a/b"]). */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Rewrites `path` when `from` (a file or folder) has moved to `to`. */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return path;
}

/**
 * Folders `path` (a note, file or folder) can be moved to, in tree order; "" is the top
 * of the vault. Not where it already is, and a folder not into itself or below it.
 */
export function moveTargets(nodes: TreeNode[], path: string): string[] {
  const here = parentPath(path);
  const out: string[] = here ? [""] : [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.kind !== "folder" || n.path === path) continue;
      if (n.path !== here) out.push(n.path);
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/**
 * What a key pressed in the file tree does: Delete moves the selected row to the trash,
 * Enter opens it (a note: with the cursor in its body). Keys typed into the tree's name
 * box (new folder, rename) are that box's own.
 */
export function treeKeyAction(key: string, inInput: boolean, selected: string | null): "delete" | "open" | null {
  if (inInput || !selected) return null;
  return key === "Delete" ? "delete" : key === "Enter" ? "open" : null;
}
