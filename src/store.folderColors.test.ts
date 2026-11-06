import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type TreeNode } from "./api";
import { useApp } from "./store";

const node = (path: string, kind: "note" | "folder" = "note"): TreeNode => ({ name: path, path, kind, mtime: 0 });

describe("folder colors in the store", () => {
  const initial = useApp.getState();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useApp.setState(initial, true);
  });

  function setup() {
    // Saving the config also applies its theme to the page.
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    const saved = vi.spyOn(api, "setConfig").mockResolvedValue(undefined as never);
    vi.spyOn(api, "setWorkspace").mockResolvedValue(undefined as never);
    vi.spyOn(api, "listNotes").mockResolvedValue([]);
    vi.spyOn(api, "listTree").mockResolvedValue([node("업무", "folder")]);
    useApp.setState({
      vault: { root: "D:/v", name: "v", drive: null, store_dir: "", store_on_this_pc: false, store_warning: null },
      flushEditor: async () => {},
      config: { ...initial.config, update_links_on_rename: false },
    });
    return saved;
  }
  const colors = () => useApp.getState().config.folder_colors;

  it("sets, changes and clears a folder's color", async () => {
    const saved = setup();
    const s = useApp.getState();
    await s.setFolderColor("업무", "#1c7ed6");
    await s.setFolderColor("개인", "#e03131");
    await s.setFolderColor("업무", "#2f9e44");
    expect(colors()).toEqual({ 업무: "#2f9e44", 개인: "#e03131" });
    await s.setFolderColor("개인", null);
    expect(colors()).toEqual({ 업무: "#2f9e44" });
    expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ folder_colors: { 업무: "#2f9e44" } }));
  });

  it("follows a renamed folder, including colored folders inside it", async () => {
    setup();
    vi.spyOn(api, "renameEntry").mockResolvedValue("회사");
    useApp.setState({ config: { ...useApp.getState().config, folder_colors: { 업무: "#1c7ed6", "업무/회의": "#e03131", 개인: "#2f9e44" } } });
    await useApp.getState().rename("업무", "회사");
    expect(colors()).toEqual({ 회사: "#1c7ed6", "회사/회의": "#e03131", 개인: "#2f9e44" });
  });

  it("forgets the colors of a deleted folder", async () => {
    setup();
    vi.spyOn(api, "deleteEntry").mockResolvedValue(undefined as never);
    useApp.setState({ config: { ...useApp.getState().config, folder_colors: { 업무: "#1c7ed6", "업무/회의": "#e03131", 업무일지: "#2f9e44" } } });
    await useApp.getState().remove("업무");
    expect(colors()).toEqual({ 업무일지: "#2f9e44" });
  });
});
