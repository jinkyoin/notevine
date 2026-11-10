import { describe, expect, it } from "vitest";
import { asksForTemplate, COMMON_INSTRUCTIONS, asksForWeb, chatPrompt, journalNotesInRange, matchTemplate, namesWeb, pickProvider, qaSystem, supportsWeb, weekRange, withInstructions, writeIntent, writePrompt } from "./ai";

describe("ai helpers", () => {
  it("allows the web only when asked to", () => {
    expect(qaSystem(false)).toContain("<참고 노트>에 있는 내용만 근거로");
    expect(qaSystem(false)).not.toContain("웹");
    expect(qaSystem(true)).toContain("웹을 검색");
    expect(qaSystem(true)).toContain("[제목](URL)");
    expect(qaSystem(true)).toContain("검색어에 넣지 말고");
  });

  it("tells the AI to search whenever the user asks for it, notes or not", () => {
    expect(qaSystem(true)).toContain("검색을 요청했거나");
    expect(qaSystem(true)).toContain("노트가 있어도 반드시 웹을 검색");
  });

  it.each([
    "'창발의 시대'란 도서를 검색하여 요약해줘",
    "창발의 시대 책 찾아서 요약해 줘",
    "웹에서 창발의 시대 요약해줘",
    "인터넷으로 찾아봐 줘: Tauri 3 출시일",
    "구글 검색해서 알려 줘",
    "웹 검색으로 최신 환율 알려줘",
    "search the web for Tauri 3",
    "look up the release date online",
    "'창발의 시대'란 도서를 검색해서 요약 노트를 새로 만들어 줘",
    "창발의 시대 책 검색해서 새 노트로 저장해 줘",
  ])("takes this as a request to search the web: %s", (q) => {
    expect(asksForWeb(q)).toBe(true);
  });

  it.each([
    "지난주 회의에서 결정한 것 정리해 줘",
    "지난주 회의 결정 찾아줘",
    "내 노트에서 도서 목록 찾아줘",
    "웹사이트 개편 일정 요약해 줘",
    "웹 접근성 관련 메모 찾아줘",
    "도서 메모 찾아줘",
    "도서 노트 검색해 줘",
    "정책 찾아줘",
    "이 글 요약해 줘",
    "이 노트에 웹에서 찾은 내용을 덧붙여 줘",
    "요약해 줘",
  ])("keeps this with the notes: %s", (q) => {
    expect(asksForWeb(q)).toBe(false);
  });

  it("keeps notes in when the request names both notes and the web", () => {
    const q = "창발의 시대를 노트나 웹에서 검색해서 작성해줘";
    expect(asksForWeb(q)).toBe(false);
    expect(namesWeb(q)).toBe(true);
    expect(writeIntent(q)).toBe("open");
  });

  it.each([
    ["이 회의록의 결정사항을 '결정사항 모음' 새 노트로 만들어 줘", "new"],
    ["창발의 시대 요약 노트를 새로 만들어 줘", "new"],
    ["독서 템플릿에 맞게 작성해줘", "open"],
    ["할 일의 담당을 김민수로 바꿔 줘", "open"],
    ["이 노트들에 태그를 달아 줘", "open"],
    ["오늘 날씨를 지금 열려있는 노트에 작성해", "open"],
    ["지금 열린 노트에 날씨 작성하라", "open"],
    ["열려 있는 노트에 오늘 할 일 적어", "open"],
    ["현재 노트에 날씨 넣어", "open"],
    ["날씨를 작성해.", "open"],
    ["보고서는 어떻게 작성해?", null],
    ["열린 노트에 뭐가 적혀 있어?", null],
    ["지난주 회의에서 결정한 것 정리해 줘", null],
    ["작성자가 누구야?", null],
  ])("reads what is to be written: %s", (q, want) => {
    expect(writeIntent(q)).toBe(want);
  });

  it("adds the folder's answer instructions after the app's own rules, which still win", () => {
    // The common instructions go with every request, set or not.
    for (const none of ["", "  \n "]) {
      const base = withInstructions("규칙", none);
      expect(base.startsWith("규칙\n\n" + COMMON_INSTRUCTIONS)).toBe(true);
      expect(base).not.toContain("<사용자 지침>");
      expect(base).toMatch(/앞의 규칙.*따른다/);
    }
    expect(COMMON_INSTRUCTIONS).toContain("> [!종류] 제목");
    expect(COMMON_INSTRUCTIONS).toContain("```mermaid");
    expect(COMMON_INSTRUCTIONS).toContain("![설명](https://…)");
    const s = withInstructions("규칙", " 결론부터 세 줄로 ");
    expect(s.startsWith("규칙\n\n")).toBe(true);
    expect(s).toContain("<사용자 지침>\n결론부터 세 줄로\n</사용자 지침>");
    expect(s.indexOf("규칙")).toBeLessThan(s.indexOf("결론부터"));
    expect(s.indexOf("<공통 지침>")).toBeLessThan(s.indexOf("<사용자 지침>"));
    expect(s).toContain("둘이 다르면 사용자 지침을 따른다");
    expect(s).toMatch(/앞의 규칙.*따른다/);
    expect(withInstructions("규칙", "가".repeat(5000))).toContain("가".repeat(4000) + "\n</사용자 지침>");
    expect(withInstructions("규칙", "가".repeat(5000))).not.toContain("가".repeat(4001));
  });

  it("finds the template a request asks for", () => {
    const list = [{ title: "독서템플릿" }, { title: "회의록" }, { title: "독서 심화 템플릿" }, { title: "01.주간 보고" }];
    expect(matchTemplate("템플릿 폴더에 있는 독서템플릿에 맞게 작성해줘", list)?.title).toBe("독서템플릿");
    expect(matchTemplate("독서 템플릿으로 써 줘", list)?.title).toBe("독서템플릿");
    expect(matchTemplate("회의록 양식대로 써 줘", list)?.title).toBe("회의록");
    expect(matchTemplate("독서 심화 템플릿에 맞게", list)?.title).toBe("독서 심화 템플릿");
    expect(matchTemplate("주간 보고 템플릿에 맞게", list)?.title).toBe("01.주간 보고");
    expect(matchTemplate("심화 템플릿에 맞게", list)?.title).toBe("독서 심화 템플릿");
    expect(matchTemplate("요리 템플릿에 맞게", list)).toBeNull();
  });

  it("tells asking for a template's format from talking about the folder", () => {
    expect(asksForTemplate("독서템플릿에 맞게 작성해줘")).toBe(true);
    expect(asksForTemplate("회의록 양식대로 써 줘")).toBe(true);
    expect(asksForTemplate("템플릿 폴더 정리 방법 알려줘")).toBe(false);
  });

  it("knows which connections can search the web", () => {
    expect(supportsWeb("claude")).toBe(true);
    expect(supportsWeb("codex")).toBe(true);
    expect(supportsWeb("ollama")).toBe(false);
    expect(supportsWeb("anthropic")).toBe(false);
    expect(supportsWeb("openai")).toBe(false);
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
