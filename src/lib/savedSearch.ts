// 저장된 검색 (FR-SRC-06): 같은 검색인지 비교, 이름 붙여 넣기, 기본 이름.
import type { SavedSearch } from "../api";

import { tx } from "../i18n";
const RANGE: Record<SavedSearch["range"], string> = { all: "", today: tx("오늘"), "7d": tx("최근 7일"), "30d": tx("최근 30일") };
const OP: Record<string, string> = { eq: "=", ne: "≠", contains: tx("포함"), empty: tx("비어 있음") };

/** Same text, conditions and period; the name doesn't count. */
export function sameSearch(a: SavedSearch, b: SavedSearch): boolean {
  const key = (s: SavedSearch) =>
    JSON.stringify([s.text.trim(), s.filters.map((f) => [f.key, f.op, f.value ?? null]), s.range === "all" ? "" : s.date_field, s.range]);
  return key(a) === key(b);
}

/** Adds a search, replacing one of the same name in place. */
export function upsertSearch(list: SavedSearch[], s: SavedSearch): SavedSearch[] {
  const i = list.findIndex((x) => x.name === s.name);
  return i < 0 ? [...list, s] : list.map((x, j) => (j === i ? s : x));
}

/** A readable summary, used as the suggested name and the chip's tooltip. */
export function searchLabel(s: SavedSearch): string {
  const parts = [s.text.trim(), ...s.filters.map((f) => `${f.key} ${OP[f.op] ?? f.op} ${f.value ?? ""}`.trim())];
  if (s.range !== "all") parts.push(`${s.date_field === "created" ? tx("생성") : tx("수정")} ${RANGE[s.range]}`);
  return parts.filter(Boolean).join(" · ");
}
