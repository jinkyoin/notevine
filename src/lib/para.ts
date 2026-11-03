// PARA(Tiago Forte) 정리: 파일 트리 우클릭 메뉴에 '새 프로젝트', '보관으로 옮기기', '…로 꺼내기' 중 무엇을 보일지.
import type { VaultConfig } from "../api";

import { tx } from "../i18n";
/** PARA folders an archived note or folder can be taken back out to. */
export type ParaFolder = "project_folder" | "area_folder" | "resource_folder";

export type ParaAction =
  | { kind: "newProject"; label: string }
  | { kind: "archive"; label: string }
  | { kind: "unarchive"; to: ParaFolder; label: string };

const TAKE_OUT: [ParaFolder, string][] = [
  ["project_folder", tx("프로젝트로 꺼내기")],
  ["area_folder", tx("영역으로 꺼내기")],
  ["resource_folder", tx("자료로 꺼내기")],
];

const inside = (path: string, folder: string) => !!folder && path.startsWith(folder + "/");

/**
 * The PARA actions for a tree entry. `exists` tells whether a folder is in the tree:
 * nothing is offered toward a folder the vault doesn't have.
 */
export function paraActions(path: string, isFolder: boolean, c: VaultConfig, exists: (folder: string) => boolean): ParaAction[] {
  if (isFolder && path === c.project_folder) return [{ kind: "newProject", label: tx("새 프로젝트") }];
  if (inside(path, c.archive_folder)) {
    return TAKE_OUT.filter(([key]) => exists(c[key])).map(([to, label]) => ({ kind: "unarchive", to, label }));
  }
  // The structure's own folders stay where they are.
  const roots = [c.inbox_folder, c.project_folder, c.area_folder, c.resource_folder, c.archive_folder, c.template_folder, c.attachment_folder];
  if (!exists(c.archive_folder) || roots.includes(path) || inside(c.archive_folder, path)) return [];
  return [{ kind: "archive", label: tx("보관으로 옮기기") }];
}
