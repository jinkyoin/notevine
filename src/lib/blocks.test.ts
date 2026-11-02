import { describe, expect, it } from "vitest";
import { blockCandidates, findBlockLine, newBlockId, noteBlock, withBlockId } from "./headings";
import { noteToHtml } from "./renderNote";

const note = ["---", "id: ^not-a-block", "---", "# 회의록", "", "첫 줄", "이어지는 줄 ^abc123", "", "- 할 일 하나 ^task-1", "- [ ] 할 일 둘", "```", "코드 ^code", "```", "| a | b |", "|---|---|"].join("\n");

describe("block links", () => {
  it("finds a block by its id, not inside frontmatter or code", () => {
    expect(findBlockLine(note, "abc123")).toBe(7);
    expect(findBlockLine(note, "^ABC123")).toBe(7);
    expect(findBlockLine(note, "task-1")).toBe(9);
    expect(findBlockLine(note, "code")).toBeNull();
    expect(findBlockLine(note, "not-a-block")).toBeNull();
  });

  it("takes the whole paragraph, or just the list item, without the id", () => {
    expect(noteBlock(note, "abc123")).toBe("첫 줄\n이어지는 줄");
    expect(noteBlock(note, "task-1")).toBe("- 할 일 하나");
    expect(noteBlock(note, "없음")).toBeNull();
  });

  it("offers body lines without list marks, headings, code or table rules", () => {
    expect(blockCandidates(note).map((b) => [b.line, b.text, b.id])).toEqual([
      [5, "첫 줄", null],
      [6, "이어지는 줄", "abc123"],
      [8, "할 일 하나", "task-1"],
      [9, "할 일 둘", null],
      [13, "| a | b |", null],
    ]);
  });

  it("adds an id to a line once, keeping CRLF line ends", () => {
    expect(withBlockId("가\r\n나  \r\n다", 1, "x1")).toBe("가\r\n나 ^x1\r\n다");
    expect(withBlockId(note, 6, "zz")).toBe(note);
    expect(withBlockId("가", 5, "zz")).toBe("가");
  });

  it("makes a new id that isn't used yet", () => {
    const seq = [0.5, 0.5, 0.25];
    const used = withBlockId("가", 0, (0.5).toString(36).slice(2, 8).padEnd(6, "0"));
    expect(newBlockId(used, () => seq.shift()!)).toBe((0.25).toString(36).slice(2, 8).padEnd(6, "0"));
  });

  it("hides the id in read mode but keeps a jump target", () => {
    const html = noteToHtml("문단 ^Abc-1\n\n가격은 2^10");
    expect(html).toContain('문단<span class="block-id" data-block="abc-1"></span>');
    expect(html).not.toContain("^Abc-1");
    expect(html).toContain("2^10");
  });
});
