// AI 입력창에 끌어다 놓은 노트·폴더 (FR-AI-03): 무엇을 보낼지 고르는 규칙만 둔다.
import type { TreeNode } from "../api";
import { findNode } from "./tree";

/**
 * The notes a dropped file-tree entry stands for: a note is itself, a folder is every
 * note under it (sub-folders too, other files left out). null: not a note or folder.
 */
export function notesUnder(tree: TreeNode[], path: string): string[] | null {
  const node = findNode(tree, path);
  if (!node || node.kind === "file") return null;
  if (node.kind === "note") return [node.path];
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const c of nodes) {
      if (c.kind === "note") out.push(c.path);
      else if (c.kind === "folder") walk(c.children ?? []);
    }
  };
  walk(node.children ?? []);
  return out;
}
