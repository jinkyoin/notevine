import { describe, expect, it } from "vitest";
import { availableCommands, matchKeys, registerCommands, runCommand } from "./commands";

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
