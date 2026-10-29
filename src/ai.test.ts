import { describe, expect, it } from "vitest";
import { chatPrompt, journalNotesInRange, pickProvider, researchNoteName, researchPrompt, weekRange, writePrompt } from "./ai";

describe("ai helpers", () => {
  it("names research notes safely", () => {
    expect(researchNoteName("Tauri 2 자동 업데이트 방법")).toBe("조사 - Tauri 2 자동 업데이트 방법");
    expect(researchNoteName('a/b:c*d?"e"<f>|g#h[i]')).toBe("조사 - a b c d e f g h i");
    expect(researchNoteName("  \n ")).toBe("조사 - 자료");
    expect([...researchNoteName("가".repeat(100))].length).toBe("조사 - ".length + 40);
    expect(researchPrompt("주제", "2026-10-29")).toContain("조사 날짜: 2026-10-29");
    expect(researchPrompt("주제", "2026-10-29")).not.toContain("내 노트와의 연결");
    expect(researchPrompt("주제", "2026-10-29", true)).toContain("## 내 노트와의 연결");
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
