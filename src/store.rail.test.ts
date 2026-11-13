// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { api, type RailFile, type TreeNode, type VaultInfo } from "./api";
import { DEFAULT_CONFIG, useApp } from "./store";
import { folderBound, useAi } from "./aiStore";
import { EditorState } from "@codemirror/state";
import { switchGuard } from "./editor/switchGuard";
import { samePath } from "./lib/rail";
import { clearSnapshots } from "./lib/vaultMemory";

const note = (path: string): TreeNode => ({ name: path, path, kind: "note", mtime: 0 });
const info = (root: string): VaultInfo => ({
  root,
  name: root.slice(root.lastIndexOf("/") + 1),
  drive: null,
  store_dir: "",
  store_on_this_pc: false,
  store_warning: null,
});

/** A pretend backend: which folders exist, which fail to open, the rail file. */
let missing: Set<string>;
let failing: Set<string>;
let rail: RailFile | null;
let backendOpen: string | null;
let opened: string[];

function fakeBackend() {
  missing = new Set();
  failing = new Set();
  rail = null;
  backendOpen = null;
  opened = [];
  const edit = (f: (r: RailFile) => void) => {
    const r = rail ?? { entries: [], active: null };
    f(r);
    rail = r;
    return Promise.resolve(structuredClone(r));
  };
  vi.spyOn(api, "openVault").mockImplementation(async (path) => {
    opened.push(path);
    // Like the backend: only the same folder closes before opening; another opens beside it.
    if (backendOpen && samePath(backendOpen, path)) backendOpen = null;
    if (failing.has(path)) throw { code: "io", message: "denied" };
    backendOpen = path;
    return info(path);
  });
  vi.spyOn(api, "recentVaults").mockResolvedValue([]);
  vi.spyOn(api, "closeVault").mockImplementation(async () => {
    backendOpen = null;
  });
  vi.spyOn(api, "getConfig").mockResolvedValue(DEFAULT_CONFIG);
  vi.spyOn(api, "deviceTrust").mockResolvedValue({ git: false, backup_minutes: 0, custom_css: false });
  vi.spyOn(api, "listTree").mockImplementation(async () => [note("x.md"), note("y.md")]);
  vi.spyOn(api, "listNotes").mockResolvedValue([]);
  vi.spyOn(api, "getWorkspace").mockResolvedValue({ open_path: null, tabs: [] });
  vi.spyOn(api, "setWorkspace").mockResolvedValue(undefined);
  vi.spyOn(api, "folderExists").mockImplementation(async (p) => !missing.has(p));
  vi.spyOn(api, "railList").mockImplementation(async () => (rail ? structuredClone(rail) : null));
  vi.spyOn(api, "railAdd").mockImplementation((path, name) =>
    edit((r) => {
      if (!r.entries.some((e) => samePath(e.path, path))) r.entries.push({ path, name });
    }),
  );
  vi.spyOn(api, "railRemove").mockImplementation((path) =>
    edit((r) => {
      r.entries = r.entries.filter((e) => !samePath(e.path, path));
      if (r.active && samePath(r.active, path)) r.active = null;
    }),
  );
  vi.spyOn(api, "railMove").mockImplementation((path, delta) =>
    edit((r) => {
      const i = r.entries.findIndex((e) => samePath(e.path, path));
      const to = Math.max(0, Math.min(r.entries.length - 1, i + delta));
      const [e] = r.entries.splice(i, 1);
      r.entries.splice(to, 0, e);
    }),
  );
  vi.spyOn(api, "railSetActive").mockImplementation(async (path) => {
    if (rail?.entries.some((e) => samePath(e.path, path))) rail.active = path;
  });
}

const root = () => useApp.getState().vault?.root ?? null;
const railPaths = () => useApp.getState().rail.map((e) => e.path);

describe("note folder rail in the store", () => {
  const initial = useApp.getState();
  const initialAi = useAi.getState();
  beforeEach(() => {
    fakeBackend();
    useApp.setState({ flushEditor: async () => {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearSnapshots();
    useApp.setState(initial, true);
    useAi.setState(initialAi, true);
  });

  it("adds an opened folder to the rail and sets it active", async () => {
    expect(await useApp.getState().openVault("D:/a")).toBe(true);
    expect(railPaths()).toEqual(["D:/a"]);
    expect(rail?.active).toBe("D:/a");
  });

  it("brings back tabs and AI chat when switching back", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    s.openNote("x.md");
    s.openNote("y.md", undefined, undefined, { newTab: true });
    useAi.setState({ chat: [{ role: "user", text: "질문" }] });
    expect(await s.switchVault("D:/b")).toBe(true);
    expect(useApp.getState()).toMatchObject({ openPath: null, tabs: [] });
    expect(useAi.getState().chat).toEqual([]);
    await s.switchVault("D:/a");
    expect(useApp.getState().tabs.map((t) => t.path)).toEqual(["x.md", "y.md"]);
    expect(useApp.getState().openPath).toBe("y.md");
    expect(useAi.getState().chat).toEqual([{ role: "user", text: "질문" }]);
    expect(railPaths()).toEqual(["D:/a", "D:/b"]);
  });

  it("changes the screen once: the new folder never shows without its tree", async () => {
    await useApp.getState().openVault("D:/a");
    const seen: { root: string | undefined; tree: number }[] = [];
    const stop = useApp.subscribe((st) => seen.push({ root: st.vault?.root, tree: st.tree.length }));
    await useApp.getState().switchVault("D:/b");
    stop();
    // Used to show "D:/b" with an empty tree (and no note) until the reads were done.
    expect(seen.filter((x) => x.root === "D:/b" && x.tree === 0)).toEqual([]);
  });

  it("brings a folder back with its tree at once, and reads the tree again after", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    await s.switchVault("D:/b");
    // The disk is slow this time: the answer for D:/a is not there when D:/a is shown.
    let answer: (t: TreeNode[]) => void = () => {};
    vi.mocked(api.listTree).mockImplementation(() => new Promise((r) => (answer = r)));
    await s.switchVault("D:/a");
    expect(useApp.getState().tree.map((n) => n.path)).toEqual(["x.md", "y.md"]);
    answer([note("x.md"), note("y.md"), note("new.md")]);
    await vi.waitFor(() => expect(useApp.getState().tree.map((n) => n.path)).toEqual(["x.md", "y.md", "new.md"]));
  });

  it("ignores a tree that was read for the folder shown before", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    let late: (t: TreeNode[]) => void = () => {};
    vi.mocked(api.listTree).mockImplementationOnce(() => new Promise((r) => (late = r)));
    const reading = s.refreshTree();
    await s.switchVault("D:/b");
    late([note("from-a.md")]);
    await reading;
    expect(useApp.getState().tree.map((n) => n.path)).toEqual(["x.md", "y.md"]);
    expect(root()).toBe("D:/b");
  });

  it("AI edits stay with their folder", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    useAi.setState({ edits: { request: "r", message: "m", items: [], applying: false, chatIndex: 0 } as never });
    await s.switchVault("D:/b");
    expect(useAi.getState().edits).toBeNull();
  });

  it("flushes before switching", async () => {
    const order: string[] = [];
    useApp.setState({ flushEditor: async () => void order.push("flush") });
    await useApp.getState().openVault("D:/a");
    vi.mocked(api.openVault).mockImplementation(async (p) => (order.push("open " + p), info(p)));
    await useApp.getState().switchVault("D:/b");
    expect(order).toEqual(["flush", "open D:/b"]);
  });

  it("stays when the folder is missing", async () => {
    await useApp.getState().openVault("D:/a");
    missing.add("D:/b");
    expect(await useApp.getState().switchVault("D:/b")).toBe(false);
    expect(opened).toEqual(["D:/a"]);
    expect(root()).toBe("D:/a");
    const toasts = useApp.getState().toasts;
    expect(toasts[toasts.length - 1]?.kind).toBe("error");
  });

  it("keeps the shown folder as it was when opening fails, without reopening it", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    s.openNote("x.md");
    useAi.setState({ chat: [{ role: "user", text: "질문" }] });
    failing.add("D:/b");
    expect(await s.switchVault("D:/b")).toBe(false);
    expect(opened).toEqual(["D:/a", "D:/b"]);
    expect(root()).toBe("D:/a");
    expect(backendOpen).toBe("D:/a");
    expect(useApp.getState().openPath).toBe("x.md");
    expect(useAi.getState().chat).toEqual([{ role: "user", text: "질문" }]);
    expect(useApp.getState().switchLocked).toBe(false);
  });

  it("closing the shown folder does not put it back when the next one fails", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    await s.switchVault("D:/b");
    await s.switchVault("D:/a");
    failing.add("D:/b");
    await s.closeRailVault();
    expect(root()).toBeNull();
    expect(rail?.entries.map((e) => e.path)).toEqual(["D:/b"]);
    expect(rail?.active).not.toBe("D:/a");
  });

  it("locks typing while the folder opens", async () => {
    await useApp.getState().openVault("D:/a");
    let lockedDuringOpen: boolean | undefined;
    vi.mocked(api.openVault).mockImplementation(async (p) => {
      lockedDuringOpen = useApp.getState().switchLocked;
      backendOpen = p;
      return info(p);
    });
    await useApp.getState().switchVault("D:/b");
    expect(lockedDuringOpen).toBe(true);
    expect(useApp.getState().switchLocked).toBe(false);
  });

  it("clicking the shown folder cancels a switch still being checked", async () => {
    await useApp.getState().openVault("D:/a");
    let answerB: (v: boolean) => void = () => {};
    vi.mocked(api.folderExists).mockImplementation((p) => (p === "D:/b" ? new Promise((r) => (answerB = r)) : Promise.resolve(true)));
    const toB = useApp.getState().switchVault("D:/b");
    expect(await useApp.getState().switchVault("D:/a")).toBe(true);
    expect(useApp.getState().switching).toBeNull();
    answerB(true);
    expect(await toB).toBe(false);
    expect(root()).toBe("D:/a");
  });

  it("closes dialogs tied to the old folder when switching", async () => {
    await useApp.getState().openVault("D:/a");
    useApp.setState({ versionView: { path: "x.md", id: null }, modal: "settings" });
    await useApp.getState().switchVault("D:/b");
    expect(useApp.getState()).toMatchObject({ versionView: null, modal: null });
  });

  it("an AI answer still running is stopped, and stays stopped in its folder", async () => {
    await useApp.getState().openVault("D:/a");
    useAi.setState({ chat: [{ role: "user", text: "q" }, { role: "ai", text: "반쯤", streaming: true }] });
    await useApp.getState().switchVault("D:/b");
    await useApp.getState().switchVault("D:/a");
    expect(useAi.getState().chat[1]).toMatchObject({ text: "반쯤", streaming: false });
    expect(useAi.getState().chat[1].error).toBeTruthy();
  });

  it("latest switch wins", async () => {
    await useApp.getState().openVault("D:/a");
    let answerB: (v: boolean) => void = () => {};
    vi.mocked(api.folderExists).mockImplementation((p) => (p === "D:/b" ? new Promise((r) => (answerB = r)) : Promise.resolve(true)));
    const s = useApp.getState();
    const toB = s.switchVault("D:/b");
    expect(useApp.getState().switching).toBe("D:/b");
    const toC = s.switchVault("D:/c");
    answerB(true);
    expect(await toB).toBe(false);
    expect(await toC).toBe(true);
    expect(opened).toEqual(["D:/a", "D:/c"]);
    expect(root()).toBe("D:/c");
    expect(useApp.getState().switching).toBeNull();
  });

  it("closing the current folder goes to the one below, then above, then the start screen", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    await s.switchVault("D:/b");
    await s.switchVault("D:/c");
    await s.switchVault("D:/b");
    await s.closeRailVault();
    expect(root()).toBe("D:/c");
    expect(railPaths()).toEqual(["D:/a", "D:/c"]);
    await s.closeRailVault();
    expect(root()).toBe("D:/a");
    await s.closeRailVault();
    expect(root()).toBeNull();
    expect(rail?.entries).toEqual([]);
  });

  it("closing a folder not on screen only takes it off the rail", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    await s.switchVault("D:/b");
    await s.closeRailVault("D:/a");
    expect(root()).toBe("D:/b");
    expect(railPaths()).toEqual(["D:/b"]);
  });

  it("temporary folder is not saved", async () => {
    await useApp.getState().openVault("D:/a");
    vi.spyOn(api, "locateNoteFile").mockResolvedValue({ root: "D:/t", rel: "x.md", in_vault: true });
    await useApp.getState().openFileFromOs("D:/t/x.md");
    expect(root()).toBe("D:/t");
    expect(useApp.getState().tempVault).toBe("D:/t");
    expect(useApp.getState().openPath).toBe("x.md");
    expect(rail?.entries.map((e) => e.path)).toEqual(["D:/a"]);
    expect(rail?.active).toBe("D:/a");
    await useApp.getState().switchVault("D:/a");
    expect(useApp.getState().tempVault).toBeNull();
    expect(railPaths()).toEqual(["D:/a"]);
  });

  it("the first Explorer open before any rail keeps the last folder as the rail's", async () => {
    vi.mocked(api.recentVaults).mockResolvedValue([{ path: "D:/old", name: "old", opened_at: 1 }]);
    vi.spyOn(api, "locateNoteFile").mockResolvedValue({ root: "D:/t", rel: "x.md", in_vault: true });
    await useApp.getState().openFileFromOs("D:/t/x.md");
    expect(root()).toBe("D:/t");
    expect(useApp.getState().tempVault).toBe("D:/t");
    expect(rail).toEqual({ entries: [{ path: "D:/old", name: "old" }], active: "D:/old" });
  });

  it("a file opened from Explorer with no rail and no earlier folder starts the rail", async () => {
    vi.spyOn(api, "locateNoteFile").mockResolvedValue({ root: "D:/t", rel: "x.md", in_vault: true });
    await useApp.getState().openFileFromOs("D:/t/x.md");
    expect(useApp.getState().tempVault).toBeNull();
    expect(rail?.entries.map((e) => e.path)).toEqual(["D:/t"]);
  });

  it("a file in a rail folder opens there as usual", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    await s.switchVault("D:/b");
    vi.spyOn(api, "locateNoteFile").mockResolvedValue({ root: "D:/a", rel: "y.md", in_vault: true });
    await s.openFileFromOs("D:/a/y.md");
    expect(root()).toBe("D:/a");
    expect(useApp.getState().tempVault).toBeNull();
  });

  it("pinning the temporary folder adds it to the rail", async () => {
    await useApp.getState().openVault("D:/a");
    vi.spyOn(api, "locateNoteFile").mockResolvedValue({ root: "D:/t", rel: "x.md", in_vault: true });
    await useApp.getState().openFileFromOs("D:/t/x.md");
    await useApp.getState().pinTempVault();
    expect(useApp.getState().tempVault).toBeNull();
    expect(railPaths()).toEqual(["D:/a", "D:/t"]);
    expect(rail?.active).toBe("D:/t");
  });

  it("closing the temporary folder goes back to the rail's folder", async () => {
    await useApp.getState().openVault("D:/a");
    vi.spyOn(api, "locateNoteFile").mockResolvedValue({ root: "D:/t", rel: "x.md", in_vault: true });
    await useApp.getState().openFileFromOs("D:/t/x.md");
    await useApp.getState().closeRailVault();
    expect(root()).toBe("D:/a");
    expect(useApp.getState().tempVault).toBeNull();
  });

  it("AI callbacks from a folder no longer shown do nothing", () => {
    const seen: string[] = [];
    const later = folderBound((s: string) => void seen.push(s));
    later("a");
    useAi.getState().restore(undefined);
    later("b");
    expect(seen).toEqual(["a"]);
  });

  it("the editor takes no typing while the folder switches", () => {
    const state = EditorState.create({ doc: "a", extensions: [switchGuard] });
    useApp.setState({ switchLocked: true });
    expect(state.update({ changes: { from: 1, insert: "b" } }).state.doc.toString()).toBe("a");
    useApp.setState({ switchLocked: false });
    expect(state.update({ changes: { from: 1, insert: "b" } }).state.doc.toString()).toBe("ab");
  });

  it("moves a folder on the rail", async () => {
    const s = useApp.getState();
    await s.openVault("D:/a");
    await s.switchVault("D:/b");
    await s.moveRail("D:/b", -1);
    expect(railPaths()).toEqual(["D:/b", "D:/a"]);
  });
});
