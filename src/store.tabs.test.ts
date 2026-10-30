import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type TreeNode } from "./api";
import { useApp } from "./store";

const note = (path: string): TreeNode => ({ name: path, path, kind: "note", mtime: 0 });

describe("tabs in the store", () => {
  const initial = useApp.getState();
  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState(initial, true);
  });

  function setup(paths = ["a.md", "b.md", "c.md"]) {
    const ws = vi.spyOn(api, "setWorkspace").mockResolvedValue(undefined as never);
    useApp.setState({ vault: { root: "D:/v", name: "v" }, tree: paths.map(note), flushEditor: async () => {} });
    return ws;
  }
  const tabPaths = () => useApp.getState().tabs.map((t) => t.path);

  it("opens in the current tab, or a new one, and saves the tabs", () => {
    const ws = setup();
    const { openNote } = useApp.getState();
    openNote("a.md");
    openNote("b.md");
    expect(tabPaths()).toEqual(["b.md"]);
    expect(useApp.getState().back).toEqual(["a.md"]);
    openNote("c.md", undefined, undefined, { newTab: true });
    expect(tabPaths()).toEqual(["b.md", "c.md"]);
    expect(useApp.getState()).toMatchObject({ openPath: "c.md", back: [] });
    expect(ws).toHaveBeenLastCalledWith("c.md", ["b.md", "c.md"]);
  });

  it("closes tabs and reopens the last closed one", () => {
    setup();
    const s = useApp.getState();
    s.openNote("a.md");
    s.openNote("b.md", undefined, undefined, { newTab: true });
    s.closeTab();
    expect(useApp.getState()).toMatchObject({ openPath: "a.md", closedTabs: ["b.md"] });
    s.reopenClosedTab();
    expect(tabPaths()).toEqual(["a.md", "b.md"]);
    expect(useApp.getState().openPath).toBe("b.md");
    s.closeTab("a.md");
    s.closeTab("b.md");
    expect(useApp.getState()).toMatchObject({ openPath: null, tabs: [] });
  });

  it("follows a rename and drops tabs of deleted notes", async () => {
    setup();
    vi.spyOn(api, "renameEntry").mockResolvedValue("새 이름.md");
    vi.spyOn(api, "deleteEntry").mockResolvedValue(undefined as never);
    vi.spyOn(api, "listNotes").mockResolvedValue([]);
    const list = vi.spyOn(api, "listTree").mockResolvedValue(["새 이름.md", "b.md", "c.md"].map(note));
    useApp.setState({ config: { ...initial.config, update_links_on_rename: false } });
    const s = useApp.getState();
    s.openNote("a.md");
    s.openNote("b.md", undefined, undefined, { newTab: true });
    await s.rename("a.md", "새 이름");
    expect(tabPaths()).toEqual(["새 이름.md", "b.md"]);
    expect(useApp.getState().openPath).toBe("b.md");
    list.mockResolvedValue(["새 이름.md", "c.md"].map(note));
    await s.remove("b.md");
    expect(tabPaths()).toEqual(["새 이름.md"]);
    expect(useApp.getState().openPath).toBe("새 이름.md");
  });

  it("drops the tab of a note another program removed", async () => {
    setup();
    vi.spyOn(api, "listNotes").mockResolvedValue([]);
    vi.spyOn(api, "listTree").mockResolvedValue(["a.md"].map(note));
    const toast = vi.fn();
    useApp.setState({ toast });
    const s = useApp.getState();
    s.openNote("a.md");
    s.openNote("b.md", undefined, undefined, { newTab: true });
    await s.refreshTree();
    expect(tabPaths()).toEqual(["a.md"]);
    expect(useApp.getState().openPath).toBe("a.md");
    expect(toast).toHaveBeenCalledOnce();
  });
});
