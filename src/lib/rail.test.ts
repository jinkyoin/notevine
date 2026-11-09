import { describe, expect, it } from "vitest";
import { nextAfterClose, railLetter, samePath } from "./rail";

describe("note folder rail rules", () => {
  it("shows the first letter of the folder name", () => {
    expect(railLetter("회사 노트")).toBe("회");
    expect(railLetter("  notes")).toBe("N");
    expect(railLetter("📘 공부")).toBe("📘");
    expect(railLetter("")).toBe("?");
  });

  it("after closing goes below first, then above", () => {
    expect(nextAfterClose(["a", "b", "c", "d"], "b")).toEqual(["c", "d", "a"]);
    expect(nextAfterClose(["a", "b", "c"], "c")).toEqual(["b", "a"]);
    expect(nextAfterClose(["a"], "a")).toEqual([]);
  });

  it("compares paths ignoring case and slash direction", () => {
    expect(samePath("C:\\Notes\\A", "c:/notes/a")).toBe(true);
    expect(samePath("C:\\Notes\\A", "C:\\Notes\\B")).toBe(false);
  });
});
