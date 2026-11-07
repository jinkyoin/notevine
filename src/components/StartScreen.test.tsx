// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recentVaults: vi.fn(),
  folderExists: vi.fn(),
  forgetVault: vi.fn(),
  installedDrives: vi.fn(),
  openVault: vi.fn(),
  dialogOpen: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    recentVaults: mocks.recentVaults,
    folderExists: mocks.folderExists,
    forgetVault: mocks.forgetVault,
    installedDrives: mocks.installedDrives,
  },
}));
vi.mock("../store", () => ({
  useApp: (select: (s: { openVault: typeof mocks.openVault }) => unknown) => select({ openVault: mocks.openVault }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.dialogOpen }));

const LOCAL = { path: "C:\\notes", name: "notes", opened_at: 2 };
const OFFLINE = { path: "\\\\offline\\share", name: "share", opened_at: 1 };

/** Answers each folder question only when the test says so. */
function heldAnswers() {
  const held = new Map<string, (there: boolean) => void>();
  mocks.folderExists.mockImplementation((path: string) => new Promise<boolean>((resolve) => held.set(path, resolve)));
  return {
    asked: () => [...held.keys()],
    answer: (path: string, there: boolean) => act(async () => held.get(path)!(there)),
  };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".recent-list li")];
const row = (name: string) => rows().find((li) => li.querySelector(".recent-name")?.textContent === name)!;
const pathText = (name: string) => row(name).querySelector(".recent-path")?.textContent;

describe("start screen recent folders", () => {
  let root: Root;
  let host: HTMLElement;

  /** A fresh module each time: auto-open happens once per app start. */
  async function show(list: unknown[]) {
    mocks.recentVaults.mockResolvedValue(list);
    const { StartScreen } = await import("./StartScreen");
    await act(async () => root.render(<StartScreen />));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.resetModules();
    vi.clearAllMocks();
    mocks.installedDrives.mockResolvedValue([]);
    mocks.forgetVault.mockResolvedValue(undefined);
    mocks.openVault.mockResolvedValue(undefined);
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows every folder while a folder has not answered, asking only about the one to open", async () => {
    const q = heldAnswers();
    await show([OFFLINE, LOCAL]);

    expect(rows().map((li) => li.querySelector(".recent-name")?.textContent)).toEqual(["share", "notes"]);
    expect(pathText("notes")).toBe(LOCAL.path);
    expect(q.asked()).toEqual([OFFLINE.path]);
  });

  it("opens the last folder at app start once it answers", async () => {
    const q = heldAnswers();
    await show([LOCAL, OFFLINE]);
    expect(mocks.openVault).not.toHaveBeenCalled();

    await q.answer(LOCAL.path, true);

    expect(mocks.openVault).toHaveBeenCalledExactlyOnceWith(LOCAL.path);
    expect(q.asked()).toEqual([LOCAL.path]);
  });

  it("marks a chosen folder as not found without trying to open it", async () => {
    const q = heldAnswers();
    await show([OFFLINE, LOCAL]);

    await q.answer(OFFLINE.path, false);

    expect(pathText("share")).toBe("찾을 수 없음");
    expect(mocks.openVault).not.toHaveBeenCalled();
  });

  it("opens a folder chosen again after it comes back", async () => {
    const q = heldAnswers();
    await show([OFFLINE]);
    await q.answer(OFFLINE.path, false);

    await act(async () => row("share").click());
    await q.answer(OFFLINE.path, true);

    expect(pathText("share")).toBe(OFFLINE.path);
    expect(mocks.openVault).toHaveBeenCalledExactlyOnceWith(OFFLINE.path);
  });

  it("drops a slow folder's answer when another folder was chosen meanwhile", async () => {
    const q = heldAnswers();
    await show([OFFLINE, LOCAL]);

    await act(async () => row("notes").click());
    await q.answer(LOCAL.path, true);
    await q.answer(OFFLINE.path, true);

    expect(mocks.openVault).toHaveBeenCalledExactlyOnceWith(LOCAL.path);
  });

  it("drops the app-start open when the folder dialog was opened meanwhile", async () => {
    const q = heldAnswers();
    mocks.dialogOpen.mockResolvedValue(null);
    await show([OFFLINE]);

    await act(async () => document.querySelector<HTMLElement>(".btn.primary")!.click());
    await q.answer(OFFLINE.path, true);

    expect(mocks.openVault).not.toHaveBeenCalled();
  });
});
