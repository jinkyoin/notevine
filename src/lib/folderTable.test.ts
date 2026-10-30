import { describe, expect, it } from "vitest";
import { MODIFIED, sortRows, TITLE, type TableRow } from "./folderTable";

const row = (title: string, mtime: number, props: Record<string, string> = {}): TableRow => ({ path: `p/${title}.md`, title, mtime, props });
const rows = [
  row("나", 3, { deadline: "2026-12-01", 순서: "10" }),
  row("가", 1, { deadline: "2026-11-05", 순서: "9" }),
  row("다", 2),
];
const titles = (col: string, desc = false) => sortRows(rows, col, desc).map((r) => r.title);

describe("folder table sorting", () => {
  it("sorts by title and by modified date", () => {
    expect(titles(TITLE)).toEqual(["가", "나", "다"]);
    expect(titles(MODIFIED, true)).toEqual(["나", "다", "가"]);
  });

  it("keeps empty cells last in both directions", () => {
    expect(titles("deadline")).toEqual(["가", "나", "다"]);
    expect(titles("deadline", true)).toEqual(["나", "가", "다"]);
  });

  it("compares numbers as numbers", () => {
    expect(titles("순서")).toEqual(["가", "나", "다"]);
  });
});
