import { describe, expect, it } from "vitest";
import { fitMenu } from "./menuPos";

describe("fitMenu", () => {
  it("opens where clicked when it fits", () => {
    expect(fitMenu(100, 100, 200, 300, 1280, 800)).toEqual({ left: 100, top: 100 });
  });

  it("opens upward near the bottom and leftward near the right", () => {
    expect(fitMenu(100, 700, 200, 300, 1280, 800)).toEqual({ left: 100, top: 400 });
    expect(fitMenu(1200, 100, 200, 300, 1280, 800)).toEqual({ left: 1000, top: 100 });
  });

  it("stays inside the window when it doesn't fit either way", () => {
    expect(fitMenu(100, 300, 200, 700, 1280, 800)).toEqual({ left: 100, top: 8 });
    expect(fitMenu(100, 500, 200, 790, 1280, 800)).toEqual({ left: 100, top: 8 });
  });
});
