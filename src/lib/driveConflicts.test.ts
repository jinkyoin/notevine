import { describe, expect, it } from "vitest";
import { unseenConflicts } from "./driveConflicts";

const a = { copy: "회의 (1).md", original: "회의.md" };
const b = { copy: "일지 (1).md", original: "일지.md" };

describe("unseenConflicts", () => {
  it("reports a copy the first time it is found", () => {
    expect(unseenConflicts([a], new Set())).toEqual([a]);
  });

  it("does not report the same copy twice", () => {
    const seen = new Set<string>();
    unseenConflicts([a], seen);
    expect(unseenConflicts([a, b], seen)).toEqual([b]);
  });

  it("reports a copy again if it went away and came back", () => {
    const seen = new Set<string>();
    unseenConflicts([a], seen);
    unseenConflicts([], seen);
    expect(unseenConflicts([a], seen)).toEqual([a]);
  });
});
