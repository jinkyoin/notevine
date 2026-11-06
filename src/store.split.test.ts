import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type TreeNode } from "./api";
import { useApp } from "./store";

const note = (path: string): TreeNode => ({ name: path, path, kind: "note", mtime: 0 });

describe("split view in the store", () => {
  const initial = useApp.getState();
  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState(initial, true);
    useApp.getState().setFlushEditor(async () => {});
    useApp.getState().setFlushEditor(async () => {}, true);
  });

  function setup() {
    vi.spyOn(api, "setWorkspace").mockResolvedValue(undefined as never);
    vi.spyOn(api, "listNotes").mockResolvedValue([]);
    useApp.setState({ vault: { root: "D:/v", name: "v", drive: null, store_dir: "", store_on_this_pc: false, store_warning: null }, tree: ["a.md", "b.md"].map(note) });
  }

  it("saves both editors", async () => {
    setup();
    const saved: string[] = [];
    useApp.getState().setFlushEditor(async () => void saved.push("main"));
    useApp.getState().setFlushEditor(async () => void saved.push("side"), true);
    await useApp.getState().flushEditor(true);
    expect(saved.sort()).toEqual(["main", "side"]);
  });

  it("follows a rename and closes when its note is deleted", async () => {
    setup();
    vi.spyOn(api, "renameEntry").mockResolvedValue("새 이름.md");
    const list = vi.spyOn(api, "listTree").mockResolvedValue(["a.md", "새 이름.md"].map(note));
    useApp.setState({ config: { ...initial.config, update_links_on_rename: false } });
    const s = useApp.getState();
    s.openNote("a.md");
    s.openSplit("b.md");
    await s.rename("b.md", "새 이름");
    expect(useApp.getState().splitPath).toBe("새 이름.md");

    vi.spyOn(api, "deleteEntry").mockResolvedValue(undefined as never);
    list.mockResolvedValue(["a.md"].map(note));
    await s.remove("새 이름.md");
    expect(useApp.getState().splitPath).toBeNull();
    expect(useApp.getState().openPath).toBe("a.md");
  });
});
