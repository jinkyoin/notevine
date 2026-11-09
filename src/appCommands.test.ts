import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppCommands } from "./appCommands";
import { availableCommands, dispatchKey, runCommand } from "./commands";
import { useApp } from "./store";

describe("app commands in the palette", () => {
  const initial = useApp.getState();
  afterEach(() => useApp.setState(initial, true));

  it("lists dialog-opening commands while the palette itself is open", () => {
    const off = registerAppCommands();
    useApp.setState({ vault: { path: "v", name: "v" } as never, openPath: "a.md", modal: "palette" });
    const ids = availableCommands().map((c) => c.id);
    for (const id of ["note.insertTemplate", "help.markdown", "note.new", "app.settings", "note.quickMemo", "note.webClip"]) {
      expect(ids).toContain(id);
    }
    useApp.setState({ modal: "settings" });
    expect(availableCommands().map((c) => c.id)).not.toContain("note.insertTemplate");
    off();
  });
});

describe("note folder rail commands", () => {
  const initial = useApp.getState();
  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState(initial, true);
  });
  const ctrl = (n: number) =>
    ({ key: String(n), code: `Digit${n}`, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: false, preventDefault() {} }) as unknown as KeyboardEvent;

  function setup() {
    const switchVault = vi.fn(async () => true);
    useApp.setState({
      vault: { root: "D:/a", name: "a" } as never,
      rail: [
        { path: "D:/a", name: "a" },
        { path: "D:/b", name: "b" },
      ],
      switchVault,
    });
    return { off: registerAppCommands(), switchVault };
  }

  it("Ctrl+2 switches to the second rail folder", () => {
    const { off, switchVault } = setup();
    expect(dispatchKey(ctrl(2))).toBe(true);
    expect(switchVault).toHaveBeenCalledExactlyOnceWith("D:/b");
    off();
  });

  it("Ctrl+3 does nothing with two rail folders", () => {
    const { off, switchVault } = setup();
    expect(dispatchKey(ctrl(3))).toBe(false);
    expect(switchVault).not.toHaveBeenCalled();
    off();
  });

  it("Ctrl+1 does nothing while a dialog is open", () => {
    const { off, switchVault } = setup();
    useApp.setState({ modal: "settings" });
    expect(dispatchKey(ctrl(1))).toBe(false);
    expect(switchVault).not.toHaveBeenCalled();
    off();
  });

  it("shortcuts wait while a folder switch is under way", () => {
    const { off, switchVault } = setup();
    useApp.setState({ switchLocked: true });
    expect(dispatchKey(ctrl(2))).toBe(false);
    expect(switchVault).not.toHaveBeenCalled();
    off();
  });

  it("vault.switch opens adding mode and vault.close closes the shown folder", () => {
    const { off } = setup();
    const closeRailVault = vi.fn(async () => {});
    useApp.setState({ closeRailVault });
    runCommand("vault.switch");
    expect(useApp.getState().adding).toBe(true);
    runCommand("vault.close");
    expect(closeRailVault).toHaveBeenCalledExactlyOnceWith();
    off();
  });
});
