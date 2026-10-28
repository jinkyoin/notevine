import { describe, expect, it } from "vitest";
import { readFrontmatter, renameProperty, setProperty, typeOf } from "./frontmatter";

const note = "---\ntype: idea # 프리셋 기본값\nstatus: 검토\ntags: [업무개선, 자동화]\nsource: https://example.com\ncreated: 2026-10-27\n---\n# 본문\n";

describe("frontmatter", () => {
  it("reads properties with types", () => {
    const fm = readFrontmatter(note);
    expect(fm.error).toBeNull();
    expect(fm.props.map((p) => [p.key, p.type])).toEqual([
      ["type", "text"],
      ["status", "text"],
      ["tags", "list"],
      ["source", "url"],
      ["created", "date"],
    ]);
    expect(fm.props[2].value).toEqual(["업무개선", "자동화"]);
    expect(note.slice(fm.bodyStart)).toBe("# 본문\n");
  });

  it("sets a value and keeps comments and the body", () => {
    const out = setProperty(note, "status", "진행")!;
    expect(out).toContain("status: 진행");
    expect(out).toContain("# 프리셋 기본값");
    expect(out.endsWith("---\n# 본문\n")).toBe(true);
  });

  it("adds a list as a flow sequence and removes keys", () => {
    const added = setProperty(note, "참여자", ["김", "이"])!;
    expect(added).toContain("참여자: [김, 이]");
    const removed = setProperty(added, "참여자", undefined)!;
    expect(removed).not.toContain("참여자");
  });

  it("creates and drops the block as needed", () => {
    const created = setProperty("본문만\n", "status", "검토")!;
    expect(created).toBe("---\nstatus: 검토\n---\n\n본문만\n");
    expect(setProperty(created, "status", undefined)).toBe("\n본문만\n");
  });

  it("keeps CRLF line endings", () => {
    const crlf = note.replace(/\n/g, "\r\n");
    const out = setProperty(crlf, "status", "완료")!;
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("refuses to rewrite broken YAML and reports it", () => {
    const broken = "---\nstatus: [검토\n---\n본문";
    expect(readFrontmatter(broken).error).not.toBeNull();
    expect(setProperty(broken, "status", "x")).toBeNull();
  });

  it("renames keys in place", () => {
    const out = renameProperty(note, "status", "상태")!;
    expect(out.indexOf("상태: 검토")).toBeLessThan(out.indexOf("tags"));
  });

  it("detects types", () => {
    expect(typeOf("2026-10-28")).toBe("date");
    expect(typeOf("https://x")).toBe("url");
    expect(typeOf(3)).toBe("number");
    expect(typeOf(["a"])).toBe("list");
  });
});
