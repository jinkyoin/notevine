import { describe, expect, it } from "vitest";
import { clampPanel, clampSidebar } from "./PanelResizer";

describe("panel width", () => {
  it("stays between the minimum and the maximum", () => {
    expect(clampSidebar(100, 600)).toBe(180);
    expect(clampSidebar(333.6, 600)).toBe(334);
    expect(clampSidebar(900, 600)).toBe(600);
    expect(clampPanel(200, 240, 500)).toBe(240);
    expect(clampPanel(700, 240, 500)).toBe(500);
  });
});
