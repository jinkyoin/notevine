import { describe, expect, it } from "vitest";
import { boardColumns, BY_NAME, dateFields, groupKeys, monthGrid, NONE, noteDate } from "./folderViews";
import { MODIFIED } from "./folderTable";

const row = (title: string, props: Record<string, string> = {}, mtime = 0) => ({ path: `p/${title}.md`, title, mtime, props });

describe("board columns", () => {
  it("puts preferred values first, then others by count, then notes without the property", () => {
    const rows = [row("a", { status: "진행" }), row("b", { status: "대기" }), row("c"), row("d", { status: "대기" }), row("e", { status: "취소" })];
    const cols = boardColumns(rows, "status", ["아이디어", "진행", "완료"]);
    expect(cols.map((c) => [c.value, c.rows.length])).toEqual([
      ["아이디어", 0],
      ["진행", 1],
      ["완료", 0],
      ["대기", 2],
      ["취소", 1],
      [NONE, 1],
    ]);
  });

  it("offers short repeated properties to group by", () => {
    const table = {
      columns: ["status", "title", "owner"],
      rows: [row("a", { status: "진행", title: "아주 긴 설명이 들어간 제목입니다, 서른 글자를 넘기는 값", owner: "나" })],
    };
    expect(groupKeys(table)).toEqual(["status", "owner"]);
  });
});

describe("calendar", () => {
  it("dates notes by a property, a date name or the modified time", () => {
    expect(noteDate(row("x", { created: "2026-11-02 09:30" }), "created")).toBe("2026-11-02");
    expect(noteDate(row("x", { created: "2026-02-30" }), "created")).toBeNull();
    expect(noteDate(row("2026-11-05"), BY_NAME)).toBe("2026-11-05");
    expect(noteDate(row("x", {}, new Date(2026, 0, 9, 15).getTime()), MODIFIED)).toBe("2026-01-09");
  });

  it("lists the fields that hold dates", () => {
    const table = { columns: ["status", "deadline", "created"], rows: [row("2026-11-01", { status: "진행", created: "2026-11-01" }), row("b", { deadline: "2026-12-01" })] };
    expect(dateFields(table)).toEqual(["deadline", "created", BY_NAME, MODIFIED]);
  });

  it("shows six weeks from the Sunday before the 1st", () => {
    const days = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-11-01");
    expect(monthGrid(2026, 11)[0]).toBe("2026-11-29");
  });
});
