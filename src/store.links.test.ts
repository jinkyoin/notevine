import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { useApp } from "./store";

const NOTE = "# 회의록\n\n내용\n\n## 결정 사항\n- 하나\n";

describe("following heading links and tags", () => {
  const initial = useApp.getState();
  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState(initial, true);
  });

  function stubBackend() {
    vi.spyOn(api, "resolveLink").mockResolvedValue("회의록.md");
    vi.spyOn(api, "readNote").mockResolvedValue(NOTE);
    vi.spyOn(api, "setWorkspace").mockResolvedValue(undefined as never);
  }

  it("opens the note on the heading's line", async () => {
    stubBackend();
    await useApp.getState().followLink("회의록", "결정 사항");
    const s = useApp.getState();
    expect(s.openPath).toBe("회의록.md");
    expect(s.jumpLine).toBe(5);
    expect(s.jumpHeading).toBe("결정 사항");
    expect(s.jumpSeq).toBe(initial.jumpSeq + 1);
  });

  it("[[#제목]] stays in the open note", async () => {
    stubBackend();
    useApp.setState({ openPath: "회의록.md", flushEditor: async () => {} });
    await useApp.getState().followLink("", "결정 사항");
    expect(api.resolveLink).not.toHaveBeenCalled();
    expect(useApp.getState().jumpLine).toBe(5);
  });

  it("opens the note at the top with a notice when the heading is missing", async () => {
    stubBackend();
    const toast = vi.fn();
    useApp.setState({ toast });
    await useApp.getState().followLink("회의록", "없는 제목");
    expect(useApp.getState().openPath).toBe("회의록.md");
    expect(useApp.getState().jumpLine).toBeNull();
    expect(toast).toHaveBeenCalledOnce();
  });

  it("a tag opens the search tab with that tag", () => {
    useApp.setState({ leftOpen: false, sidebarTab: "files" });
    useApp.getState().searchTag("업무/기획");
    const s = useApp.getState();
    expect(s).toMatchObject({ leftOpen: true, sidebarTab: "search", searchSeed: "#업무/기획" });
    expect(s.searchFocusSeq).toBe(initial.searchFocusSeq + 1);
  });
});
