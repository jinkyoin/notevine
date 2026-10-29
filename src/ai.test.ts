import { describe, expect, it } from "vitest";
import { chatPrompt, journalNotesInRange, pickProvider, qaSystem, weekRange, writePrompt } from "./ai";

describe("ai helpers", () => {
  it("allows the web only when asked to", () => {
    expect(qaSystem(false)).toContain("<참고 노트>에 있는 내용만 근거로");
    expect(qaSystem(false)).not.toContain("웹");
    expect(qaSystem(true)).toContain("웹을 검색");
    expect(qaSystem(true)).toContain("[제목](URL)");
    expect(qaSystem(true)).toContain("검색어에 넣지 말고");
  });

  it("computes Monday–Sunday and the ISO week", () => {
    expect(weekRange(new Date(2026, 9, 28))).toEqual({ from: "2026-10-26", to: "2026-11-01", label: "2026-W44" });
    expect(weekRange(new Date(2026, 10, 1))).toEqual({ from: "2026-10-26", to: "2026-11-01", label: "2026-W44" });
    expect(weekRange(new Date(2027, 0, 1)).label).toBe("2026-W53");
  });

  it("picks journal notes of the week only", () => {
    const paths = [
      "10 업무일지/2026/2026-10-25.md",
      "10 업무일지/2026/2026-10-26.md",
      "10 업무일지/2026/2026-11-01.md",
      "20 아이디어/2026-10-27 아이디어.md",
      "10 업무일지/메모.md",
    ];
    expect(journalNotesInRange(paths, "10 업무일지", "2026-10-26", "2026-11-01")).toEqual([
      "10 업무일지/2026/2026-10-26.md",
      "10 업무일지/2026/2026-11-01.md",
    ]);
  });

  it("prefers the chosen provider when it is usable", () => {
    const list = [
      { id: "claude", name: "Claude Code", available: true, version: "2", logged_in: null, detail: null },
      { id: "codex", name: "Codex", available: true, version: "1", logged_in: false, detail: "로그인 필요" },
    ] as const;
    expect(pickProvider([...list], "codex")?.id).toBe("claude");
    expect(pickProvider([...list], "")?.id).toBe("claude");
  });

  it("builds prompts", () => {
    expect(writePrompt("summarize", "회의록", "본문")).toContain("<글>\n본문\n</글>");
    expect(chatPrompt([], "질문")).toBe("질문: 질문");
    expect(chatPrompt([{ role: "user", text: "a" }, { role: "ai", text: "b" }], "c")).toContain("사용자: a\n\nAI: b");
  });
});
