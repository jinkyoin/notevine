import { describe, expect, it } from "vitest";
import { availableCommands, keysFromEvent, matchKeys, registerCommands, runCommand, setKeyOverrides } from "./commands";

const ev = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: false,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe("matchKeys", () => {
  it("matches modifiers exactly", () => {
    expect(matchKeys(ev("d", { ctrl: true, shift: true }), "Ctrl+Shift+D")).toBe(true);
    expect(matchKeys(ev("D", { ctrl: true, shift: true }), "Ctrl+Shift+D")).toBe(true);
    expect(matchKeys(ev("d", { ctrl: true }), "Ctrl+Shift+D")).toBe(false);
    expect(matchKeys(ev("n", { ctrl: true, shift: true }), "Ctrl+N")).toBe(false);
  });

  it("handles symbols changed by Shift and special keys", () => {
    expect(matchKeys(ev("|", { ctrl: true, shift: true }), "Ctrl+Shift+\\")).toBe(true);
    expect(matchKeys(ev("\\", { ctrl: true }), "Ctrl+\\")).toBe(true);
    expect(matchKeys(ev(",", { ctrl: true }), "Ctrl+,")).toBe(true);
    expect(matchKeys(ev("F2"), "F2")).toBe(true);
    expect(matchKeys(ev("ArrowLeft", { alt: true }), "Alt+ArrowLeft")).toBe(true);
  });
});

describe("registry", () => {
  it("registers, filters by when, runs and unregisters", () => {
    let ran = 0;
    let enabled = false;
    const off = registerCommands([
      { id: "t.a", title: "A", run: () => ran++ },
      { id: "t.b", title: "B", when: () => enabled, run: () => ran++ },
    ]);
    expect(availableCommands().map((c) => c.id)).toContain("t.a");
    expect(availableCommands().map((c) => c.id)).not.toContain("t.b");
    expect(runCommand("t.b")).toBe(false);
    enabled = true;
    expect(runCommand("t.b")).toBe(true);
    expect(ran).toBe(1);
    off();
    expect(runCommand("t.a")).toBe(false);
  });
});

describe("user shortcuts", () => {
  const ev = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

  it("writes a key press the way commands do", () => {
    expect(keysFromEvent(ev("n", "KeyN", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+N");
    expect(keysFromEvent(ev("!", "Digit1", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
    expect(keysFromEvent(ev("F2", "F2"))).toBe("F2");
    expect(keysFromEvent(ev("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe("Alt+ArrowLeft");
    expect(keysFromEvent(ev("Control", "ControlLeft", { ctrlKey: true }))).toBeNull();
    // A Korean keyboard layout still gives the key's letter.
    expect(keysFromEvent(ev("ㅜ", "KeyN", { ctrlKey: true }))).toBe("Ctrl+N");
    expect(matchKeys(ev("!", "Digit1", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+1")).toBe(true);
  });

  it("replace or remove a command's own shortcut", () => {
    const off = registerCommands([
      { id: "t.k", title: "K", keys: "Ctrl+K", run: () => {} },
      { id: "t.j", title: "J", keys: "Ctrl+J", run: () => {} },
    ]);
    const keys = (id: string) => availableCommands().find((c) => c.id === id)?.keys;
    setKeyOverrides({ "t.k": "Ctrl+Shift+K", "t.j": "" });
    expect([keys("t.k"), keys("t.j")]).toEqual(["Ctrl+Shift+K", undefined]);
    setKeyOverrides({});
    expect([keys("t.k"), keys("t.j")]).toEqual(["Ctrl+K", "Ctrl+J"]);
    off();
  });
});
