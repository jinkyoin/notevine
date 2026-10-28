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
