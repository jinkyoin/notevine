// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const covered = vi.hoisted(() => ({ now: true }));
vi.mock("./lockStore", () => ({ isCovered: () => covered.now }));

import { installKeyGuard } from "./keyGuard";

describe("keys while locked", () => {
  let off: () => void;
  const heard = vi.fn();
  let below: HTMLInputElement;
  let onLock: HTMLInputElement;

  /** A key press on `target`; tells whether it was cancelled. */
  function press(target: Element, type = "keydown", ctrlKey = true) {
    const e = new KeyboardEvent(type, { key: "n", code: "KeyN", ctrlKey, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  }

  beforeEach(() => {
    covered.now = true;
    heard.mockClear();
    document.body.innerHTML = `<div id="root"><input id="below"></div><div class="lock-screen"><input id="on"></div>`;
    below = document.querySelector("#below")!;
    onLock = document.querySelector("#on")!;
    // Installed first, as main.tsx does, then the app's own listeners.
    off = installKeyGuard();
    window.addEventListener("keydown", heard);
    window.addEventListener("keydown", heard, true);
    below.addEventListener("keydown", heard);
  });

  afterEach(() => {
    off();
    window.removeEventListener("keydown", heard);
    window.removeEventListener("keydown", heard, true);
  });

  it("keys under the lock reach no listener and are cancelled", () => {
    expect(press(below)).toBe(true);
    expect(press(document.body, "keyup")).toBe(true);
    expect(heard).not.toHaveBeenCalled();
  });

  it("typing in the lock screen is not cancelled, yet app shortcuts never hear it", () => {
    expect(press(onLock, "keydown", false)).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });

  const cancelled = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    onLock.dispatchEvent(e);
    return e.defaultPrevented;
  };

  // A reload would throw away edits kept behind the lock.
  it("the browser's own keys do nothing on the lock screen", () => {
    for (const init of [
      { key: "F5", code: "F5" },
      { key: "r", code: "KeyR", ctrlKey: true },
      { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true },
      { key: "p", code: "KeyP", ctrlKey: true },
      { key: "s", code: "KeyS", ctrlKey: true },
      { key: "ArrowLeft", code: "ArrowLeft", altKey: true },
      { key: "BrowserRefresh", code: "BrowserRefresh" },
    ]) {
      expect(cancelled(init), JSON.stringify(init)).toBe(true);
    }
  });

  it("typing, editing, pasting a password and Alt+F4 still work there", () => {
    for (const init of [
      { key: "a", code: "KeyA" },
      { key: "Enter", code: "Enter" },
      { key: "Tab", code: "Tab" },
      { key: "v", code: "KeyV", ctrlKey: true },
      { key: "a", code: "KeyA", ctrlKey: true },
      { key: "Backspace", code: "Backspace", ctrlKey: true },
      { key: "@", code: "KeyQ", ctrlKey: true, altKey: true },
      { key: "F4", code: "F4", altKey: true },
    ]) {
      expect(cancelled(init), JSON.stringify(init)).toBe(false);
    }
  });

  it("has no right-click menu while locked, except in the password box", () => {
    const menu = (target: Element) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(menu(document.querySelector(".lock-screen")!)).toBe(true);
    expect(menu(onLock)).toBe(false);
    covered.now = false;
    expect(menu(document.querySelector(".lock-screen")!)).toBe(false);
  });

  it("does nothing while unlocked", () => {
    covered.now = false;
    expect(press(below)).toBe(false);
    expect(heard).toHaveBeenCalledTimes(3);
  });
});
