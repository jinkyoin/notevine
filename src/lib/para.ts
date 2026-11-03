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

/** What goes in each folder of the base structure, in one sentence (file tree tooltip, folder view). */
export function paraInfo(path: string, c: VaultConfig): string | null {
  if (!c.preset_enabled || !path) return null;
  const info: [string, string][] = [
    [c.inbox_folder, tx("정리 전 메모: 일단 적어 두고, 주마다 아래 폴더로 옮기거나 지웁니다")],
    [c.project_folder, tx("프로젝트: 끝(마감)과 목표가 있는 일. 끝나면 보관으로 옮깁니다")],
    [c.area_folder, tx("영역: 끝이 없고 계속 맡아 챙기는 일(업무일지·운영·관리)")],
    [c.resource_folder, tx("자료: 나중에 쓸 참고 자료와 관심 주제")],
    [c.idea_folder, tx("아이디어: 떠오른 생각. 상태(아이디어→검토→진행)로 관리합니다")],
    [c.research_folder, tx("조사 자료: 찾아보고 정리한 자료")],
    [c.archive_folder, tx("보관: 끝났거나 쉬는 것. 검색·링크는 그대로입니다")],
    [c.template_folder, tx("템플릿: 새 노트의 틀 (Ctrl+N, Ctrl+T)")],
    [c.attachment_folder, tx("첨부: 노트에 넣은 그림·파일")],
  ];
  return info.find(([folder]) => folder === path)?.[1] ?? null;
}

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
