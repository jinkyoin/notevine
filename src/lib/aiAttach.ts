// AI 입력창에 끌어다 놓은 노트·폴더·파일 (FR-AI-03): 무엇을 보낼지 고르는 규칙만 둔다.
// 노트가 아닌 파일은 글자를 뽑을 수 있는 것(PDF, 텍스트, Office, 한글 hwpx)만 보낸다.
import type { TreeNode } from "../api";
import { findNode } from "./tree";

/** Must match TEXT_EXT and the Office/hwpx kinds in src-tauri/src/filetext.rs (PDF is read here). */
const SENDABLE_EXT = new Set([
  "pdf", "docx", "xlsx", "pptx", "hwpx",
  "txt", "text", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "html",
  "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs",
  "go", "rb", "php", "swift", "sql", "sh", "ps1", "bat", "cmd", "r", "tex", "rst", "org", "srt", "vtt",
]);

/** A file (not a note) whose text can go to AI. */
export function isSendableFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") && SENDABLE_EXT.has(path.slice(dot + 1).toLowerCase());
}

/**
 * What a dropped file-tree entry stands for: a note or a readable file is itself, a folder
 * is every note and readable file under it (sub-folders too). null: nothing that can be sent.
 */
export function entriesUnder(tree: TreeNode[], path: string): { notes: string[]; files: string[] } | null {
  const node = findNode(tree, path);
  if (!node) return null;
  if (node.kind === "note") return { notes: [node.path], files: [] };
  if (node.kind === "file") return isSendableFile(node.path) ? { notes: [], files: [node.path] } : null;
  const notes: string[] = [];
  const files: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const c of nodes) {
      if (c.kind === "note") notes.push(c.path);
      else if (c.kind === "file" && isSendableFile(c.path)) files.push(c.path);
      else if (c.kind === "folder") walk(c.children ?? []);
    }
  };
  walk(node.children ?? []);
  return { notes, files };
}
