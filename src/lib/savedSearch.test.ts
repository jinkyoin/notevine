import { describe, expect, it } from "vitest";
import type { SavedSearch } from "../api";
import { sameSearch, searchLabel, upsertSearch } from "./savedSearch";

const s = (over: Partial<SavedSearch> = {}): SavedSearch => ({ name: "", text: "status:진행", filters: [], date_field: "modified", range: "all", ...over });

describe("saved searches", () => {
  it("compares searches without the name, and ignores the date field when no period is set", () => {
    expect(sameSearch(s({ name: "a" }), s({ name: "b", text: " status:진행 " }))).toBe(true);
    expect(sameSearch(s(), s({ date_field: "created" }))).toBe(true);
    expect(sameSearch(s({ range: "7d" }), s({ range: "7d", date_field: "created" }))).toBe(false);
    expect(sameSearch(s(), s({ filters: [{ key: "owner", op: "empty", value: null }] }))).toBe(false);
  });

  it("replaces a search of the same name in place", () => {
    const list = [s({ name: "a" }), s({ name: "b" })];
    expect(upsertSearch(list, s({ name: "a", text: "#웹" })).map((x) => [x.name, x.text])).toEqual([
      ["a", "#웹"],
      ["b", "status:진행"],
    ]);
    expect(upsertSearch(list, s({ name: "c" }))).toHaveLength(3);
  });

  it("describes a search", () => {
    expect(searchLabel(s({ filters: [{ key: "owner", op: "eq", value: "나" }], range: "7d" }))).toBe("status:진행 · owner = 나 · 수정 최근 7일");
  });
});
