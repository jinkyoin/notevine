import { describe, expect, it } from "vitest";
import { closeOtherTabs, closeTab, dropTabs, goHistory, openTab, remapTabs, stepTab, type Tabs } from "./tabs";

const empty: Tabs = { tabs: [], active: null };
const paths = (s: Tabs) => s.tabs.map((t) => t.path);

describe("tabs", () => {
  it("opens in the current tab, a new tab on request, and reuses an open note's tab", () => {
    let s = openTab(empty, "a.md", false);
    expect(s).toEqual({ tabs: [{ path: "a.md", back: [], forward: [] }], active: "a.md" });
    s = openTab(s, "b.md", false);
    expect(paths(s)).toEqual(["b.md"]);
    expect(s.tabs[0].back).toEqual(["a.md"]);
    s = openTab(s, "c.md", true);
    expect(paths(s)).toEqual(["b.md", "c.md"]);
    s = openTab({ ...s, active: "b.md" }, "d.md", true);
    expect(paths(s)).toEqual(["b.md", "d.md", "c.md"]);
    s = openTab(s, "c.md", false);
    expect(s.active).toBe("c.md");
    expect(paths(s)).toEqual(["b.md", "d.md", "c.md"]);
  });

  it("closes a tab and shows its right neighbour, else the left one", () => {
    const s: Tabs = { tabs: ["a", "b", "c"].map((p) => ({ path: p, back: [], forward: [] })), active: "b" };
    expect(closeTab(s, "b")).toMatchObject({ active: "c" });
    expect(closeTab({ ...s, active: "c" }, "c")).toMatchObject({ active: "b" });
    expect(closeTab(s, "a")).toMatchObject({ active: "b" });
    expect(closeTab({ tabs: [s.tabs[0]], active: "a" }, "a")).toEqual(empty);
    expect(paths(closeOtherTabs(s, "c"))).toEqual(["c"]);
  });

  it("steps through tabs, wrapping around", () => {
    const s: Tabs = { tabs: ["a", "b", "c"].map((p) => ({ path: p, back: [], forward: [] })), active: "c" };
    expect(stepTab(s, 1).active).toBe("a");
    expect(stepTab(s, -1).active).toBe("b");
  });

  it("goes back and forward within a tab", () => {
    let s = openTab(empty, "a", false);
    s = openTab(s, "b", false);
    s = openTab(s, "c", false);
    s = goHistory(s, -1, () => true)!;
    expect(s.tabs[0]).toEqual({ path: "b", back: ["a"], forward: ["c"] });
    s = goHistory(s, 1, () => true)!;
    expect(s.tabs[0]).toEqual({ path: "c", back: ["a", "b"], forward: [] });
    expect(goHistory(s, 1, () => true)).toBeNull();
    // Gone notes are skipped and forgotten.
    s = goHistory(s, -1, (p) => p !== "b")!;
    expect(s.tabs[0]).toEqual({ path: "a", back: [], forward: ["c"] });
  });

  it("switches to the other tab when the note to go back to is open there", () => {
    let s = openTab(empty, "a", false);
    s = openTab(s, "b", false); // tab 1: a → b
    s = openTab(s, "a", true); // a in a new tab
    s = { ...s, active: "b" };
    s = goHistory(s, -1, () => true)!;
    expect(s.active).toBe("a");
    expect(paths(s)).toEqual(["b", "a"]);
    expect(s.tabs[0].back).toEqual([]);
  });

  it("follows renames and drops deleted notes", () => {
    let s = openTab(empty, "x/a.md", false);
    s = openTab(s, "b.md", false);
    s = openTab(s, "x/c.md", true);
    const moved = remapTabs(s, (p) => p.replace(/^x\//, "y/"));
    expect(paths(moved)).toEqual(["b.md", "y/c.md"]);
    expect(moved.tabs[0].back).toEqual(["y/a.md"]);
    expect(moved.active).toBe("y/c.md");
    const dropped = dropTabs(moved, (p) => !p.startsWith("y/"));
    expect(dropped).toEqual({ tabs: [{ path: "b.md", back: [], forward: [] }], active: "b.md" });
  });
});
