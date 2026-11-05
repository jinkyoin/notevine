import { describe, expect, it } from "vitest";
import { appendText, applyChanges, cleanPath, diffHunks, editSystem, lineDiff, parseEdits, planEdit, type PlanContext } from "./aiEdits";

const ANSWER = `회의록 두 개에서 결정사항을 모아 새 노트를 만들고, 원래 회의록에 링크를 답니다.

=== CREATE: 00.Inbox/결정사항 모음.md ===
# 결정사항 모음

- 3월 개통 ([[회의 1차]])
=== END ===

=== APPEND: 회의 1차.md ===
관련: [[결정사항 모음]]
=== END ===

=== EDIT: 회의 2차.md ===
--- FIND ---
- 담당: 미정
--- REPLACE ---
- 담당: 김민수
--- FIND ---
status: 검토
--- REPLACE ---
status: 진행
=== END ===`;

describe("parseEdits", () => {
  it("reads the explanation and each kind of block", () => {
    const { message, edits } = parseEdits(ANSWER);
    expect(message).toBe("회의록 두 개에서 결정사항을 모아 새 노트를 만들고, 원래 회의록에 링크를 답니다.");
    expect(edits).toEqual([
      { kind: "create", path: "00.Inbox/결정사항 모음.md", content: "# 결정사항 모음\n\n- 3월 개통 ([[회의 1차]])" },
      { kind: "append", path: "회의 1차.md", content: "관련: [[결정사항 모음]]" },
      {
        kind: "edit",
        path: "회의 2차.md",
        changes: [
          { find: "- 담당: 미정", replace: "- 담당: 김민수" },
          { find: "status: 검토", replace: "status: 진행" },
        ],
      },
    ]);
  });

  it("copes with fences, CRLF, quotes and a missing END", () => {
    const { message, edits } = parseEdits("```\r\n=== CREATE: \"a.md\" ===\r\n```markdown\r\n# A\r\n```\r\n=== APPEND: b.md ===\r\n끝\r\n```");
    expect(message).toBe("");
    expect(edits).toEqual([
      { kind: "create", path: "a.md", content: "# A" },
      { kind: "append", path: "b.md", content: "끝\n```" },
    ]);
    expect(parseEdits("할 일이 없습니다.").edits).toEqual([]);
  });
});

describe("applying", () => {
  it("keeps paths inside the vault and makes them notes", () => {
    expect(cleanPath("폴더\\새 노트")).toBe("폴더/새 노트.md");
    expect(cleanPath("./a/b.md")).toBe("a/b.md");
    expect(cleanPath("../밖.md")).toBeNull();
    expect(cleanPath(".app/config.md")).toBeNull();
    expect(cleanPath("a:b.md")).toBeNull();
  });

  it("replaces text found exactly once, loosely about spaces", () => {
    expect(applyChanges("a\n- 담당: 미정\nb", [{ find: "- 담당: 미정", replace: "- 담당: 김" }])).toEqual({ text: "a\n- 담당: 김\nb" });
    expect(applyChanges("담당:   미정\r\n", [{ find: "담당: 미정", replace: "X" }])).toEqual({ text: "X\n" });
    expect(applyChanges("x x", [{ find: "x", replace: "y" }])).toEqual({ error: "바꿀 원래 글이 노트에 여러 군데 있어 어디인지 모릅니다" });
    expect(applyChanges("abc", [{ find: "a", replace: "1" }, { find: "zz", replace: "2" }])).toEqual({ error: "바꿀 원래 글을 노트에서 찾지 못했습니다 (2번째)" });
  });

  it("appends after a blank line", () => {
    expect(appendText("# 제목\n본문\n\n\n", "추가")).toBe("# 제목\n본문\n\n추가\n");
    expect(appendText("", "추가")).toBe("추가\n");
  });

  it("plans only what is allowed", async () => {
    const files: Record<string, string> = { "회의 1차.md": "# 1차\n", "회의 2차.md": "- 담당: 미정\nstatus: 검토\n", "비밀.md": "x" };
    const ctx: PlanContext = { sent: new Set(["회의 1차.md", "회의 2차.md"]), exists: (p) => p in files, read: async (p) => files[p] };
    const plans = await Promise.all(parseEdits(ANSWER).edits.map((e) => planEdit(e, ctx)));
    expect(plans.map((p) => p.error)).toEqual([null, null, null]);
    expect(plans[1].after).toBe("# 1차\n\n관련: [[결정사항 모음]]\n");
    expect(plans[2].after).toBe("- 담당: 김민수\nstatus: 진행\n");
    expect((await planEdit({ kind: "append", path: "비밀.md", content: "x" }, ctx)).error).toBe("AI에 보내지 않은 노트라 고칠 수 없습니다");
    expect((await planEdit({ kind: "create", path: "회의 1차", content: "x" }, ctx)).error).toBe("같은 이름의 노트가 이미 있습니다");
    expect((await planEdit({ kind: "edit", path: "없음.md", changes: [] }, ctx)).error).toBe("없는 노트입니다");
  });
});

describe("lineDiff", () => {
  it("marks added and removed lines and folds unchanged runs", () => {
    const rows = lineDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nX\ne\nf\ng\nh\n");
    expect(rows.filter((r) => r.kind !== "same")).toEqual([
      { kind: "del", text: "d" },
      { kind: "add", text: "X" },
      { kind: "add", text: "h" },
    ]);
    expect(diffHunks(rows, 1)).toEqual([
      { skip: 2 },
      { kind: "same", text: "c" },
      { kind: "del", text: "d" },
      { kind: "add", text: "X" },
      { kind: "same", text: "e" },
      { skip: 1 },
      { kind: "same", text: "g" },
      { kind: "add", text: "h" },
    ]);
    expect(lineDiff("", "새\n줄\n")).toEqual([
      { kind: "add", text: "새" },
      { kind: "add", text: "줄" },
    ]);
  });
});

describe("editSystem", () => {
  const base = { folders: [], newNoteDir: "", today: "2026-11-05" };
  it("proposes only when asked to change notes", () => {
    expect(editSystem(base)).toContain("분명히 요청하지 않았으면 블록을 쓰지 말고");
    expect(editSystem({ ...base, intent: "new" })).toContain("CREATE 블록으로");
  });
  it("writes to the open note by an alias, not its path", () => {
    const s = editSystem({ ...base, intent: "open", target: "독서 기록" });
    expect(s).toContain("독서 기록");
    expect(s).toContain("APPEND: 열린노트.md");
  });
  it("answers with the text when no note is open", () => {
    const s = editSystem({ ...base, intent: "open" });
    expect(s).toContain("열린 노트가 없다");
    expect(s).toContain("결과 글 자체를 답으로");
  });
  it("names the template to follow and folders only when given", () => {
    expect(editSystem(base)).not.toContain("템플릿");
    expect(editSystem({ ...base, template: "90.템플릿/독서.md" })).toContain('path="90.템플릿/독서.md"');
    expect(editSystem(base)).not.toContain("있는 폴더");
    expect(editSystem({ ...base, folders: ["10.프로젝트"] })).toContain("있는 폴더: 10.프로젝트");
  });
});
