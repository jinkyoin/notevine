// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyNoteZoom, clampZoom, installNoteZoom, loadNoteZoom, onNoteZoom, wheelSteps } from "./noteZoom";

const root = () => document.documentElement;
const wheel = (el: Element, init: WheelEventInit) => {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  localStorage.clear();
  root().style.removeProperty("--note-zoom");
  document.body.innerHTML = `<div id="note"><p id="text">본문</p></div>`;
});

describe("zoom value", () => {
  it("stays between 50% and 300%, in whole steps of 10", () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(900)).toBe(300);
    expect(clampZoom(133)).toBe(130);
    expect(clampZoom(NaN)).toBe(100);
  });

  it("is remembered on this PC and starts at 100% without it", () => {
    expect(loadNoteZoom()).toBe(100);
    localStorage.setItem("notevine.noteZoom", "150");
    expect(loadNoteZoom()).toBe(150);
    localStorage.setItem("notevine.noteZoom", "garbage");
    expect(loadNoteZoom()).toBe(100);
  });

  it("is published as a CSS scale on the page", () => {
    applyNoteZoom(150);
    expect(root().style.getPropertyValue("--note-zoom")).toBe("1.5");
    expect(localStorage.getItem("notevine.noteZoom")).toBe("150");
    applyNoteZoom(100);
    expect(localStorage.getItem("notevine.noteZoom")).toBeNull();
  });
});

describe("wheel steps", () => {
  it("is one step per mouse notch, up when the wheel rolls away", () => {
    expect(wheelSteps(0, -100, 0)).toEqual({ steps: 1, rest: 0 });
    expect(wheelSteps(0, 100, 0)).toEqual({ steps: -1, rest: 0 });
  });

  it("collects small trackpad movements until they add up to a step", () => {
    let r = wheelSteps(0, -30, 0);
    expect(r.steps).toBe(0);
    r = wheelSteps(r.rest, -30, 0);
    r = wheelSteps(r.rest, -30, 0);
    expect(r.steps).toBe(0);
    r = wheelSteps(r.rest, -30, 0);
    expect(r.steps).toBe(1);
  });

  it("reads line-based wheels as lines, not pixels", () => {
    expect(wheelSteps(0, -3, 1).steps).toBe(1);
  });
});

describe("Ctrl + wheel on the note", () => {
  it("zooms in and out and does not let the page zoom itself", () => {
    const onChange = vi.fn();
    const stop = onNoteZoom(onChange);
    const off = installNoteZoom(document.querySelector<HTMLElement>("#note")!);
    const text = document.querySelector("#text")!;

    const up = wheel(text, { ctrlKey: true, deltaY: -100 });
    expect(up.defaultPrevented).toBe(true);
    expect(root().style.getPropertyValue("--note-zoom")).toBe("1.1");
    expect(onChange).toHaveBeenCalledTimes(1);

    wheel(text, { ctrlKey: true, deltaY: 100 });
    wheel(text, { ctrlKey: true, deltaY: 100 });
    expect(root().style.getPropertyValue("--note-zoom")).toBe("0.9");
    expect(onChange).toHaveBeenCalledTimes(3);
    off();
    stop();
  });

  it("leaves a plain wheel alone, so the note still scrolls", () => {
    const off = installNoteZoom(document.querySelector<HTMLElement>("#note")!);
    const e = wheel(document.querySelector("#text")!, { deltaY: -100 });
    expect(e.defaultPrevented).toBe(false);
    expect(root().style.getPropertyValue("--note-zoom")).toBe("");
    off();
  });

  it("stops at the limits", () => {
    const off = installNoteZoom(document.querySelector<HTMLElement>("#note")!);
    const text = document.querySelector("#text")!;
    for (let i = 0; i < 40; i++) wheel(text, { ctrlKey: true, deltaY: -100 });
    expect(root().style.getPropertyValue("--note-zoom")).toBe("3");
    for (let i = 0; i < 40; i++) wheel(text, { ctrlKey: true, deltaY: 100 });
    expect(root().style.getPropertyValue("--note-zoom")).toBe("0.5");
    off();
  });

  it("stops listening when removed", () => {
    const off = installNoteZoom(document.querySelector<HTMLElement>("#note")!);
    off();
    const e = wheel(document.querySelector("#text")!, { ctrlKey: true, deltaY: -100 });
    expect(e.defaultPrevented).toBe(false);
  });
});
