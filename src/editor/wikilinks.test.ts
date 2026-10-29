import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { linkAt, linkKey, resolveDest } from "./wikilinks";

describe("wikilinks", () => {
  it("keys ignore case, NFC and .md", () => {
    expect(linkKey("회의록.MD".normalize("NFD"))).toBe("회의록");
    expect(linkKey(" Note ")).toBe("note");
  });

  it("finds the link under a position", () => {
    const state = EditorState.create({ doc: "참고 [[회의록#결정|어제 회의]] 그리고 [자료](../a%20b.md \"t\")" });
    expect(linkAt(state, 6)).toEqual({ kind: "wiki", target: "회의록", heading: "결정" });
    const md = state.doc.toString().indexOf("자료");
    expect(linkAt(state, md)).toEqual({ kind: "md", dest: "../a%20b.md" });
    expect(linkAt(state, 1)).toBeNull();
    const plain = EditorState.create({ doc: "[[회의록]] [[#할 일]] [[#]]" });
    expect(linkAt(plain, 2)).toEqual({ kind: "wiki", target: "회의록", heading: null });
    expect(linkAt(plain, 10)).toEqual({ kind: "wiki", target: "", heading: "할 일" });
    expect(linkAt(plain, 19)).toBeNull();
  });

  it("resolves markdown destinations relative to the note", () => {
    expect(resolveDest("일지/a.md", "../30%20조사자료/b.md#요약")).toBe("30 조사자료/b.md");
    expect(resolveDest("a.md", "./c.md")).toBe("c.md");
    expect(resolveDest("a.md", "../x.md")).toBeNull();
  });
});
