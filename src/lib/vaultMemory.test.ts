import { afterEach, describe, expect, it } from "vitest";
import { clearSnapshots, dropSnapshot, keepSnapshot, takeSnapshot, viewKey, type VaultSnapshot } from "./vaultMemory";

const snap: VaultSnapshot = {
  tabs: [{ path: "x.md", back: [], forward: [] }],
  openPath: "x.md",
  closedTabs: [],
  splitPath: null,
  expanded: ["f"],
  tableView: null,
  pdfView: null,
  canvasView: null,
  ai: { chat: [] },
};

describe("what each note folder had on screen", () => {
  afterEach(clearSnapshots);

  it("gives the snapshot back once, whatever the path's case or slashes", () => {
    keepSnapshot("C:\\A", snap);
    expect(takeSnapshot("c:/a")).toEqual(snap);
    expect(takeSnapshot("C:\\A")).toBeUndefined();
  });

  it("drops a folder's snapshot", () => {
    keepSnapshot("C:\\A", snap);
    dropSnapshot("c:\\a");
    expect(takeSnapshot("C:\\A")).toBeUndefined();
  });

  it("keeps notes with the same path in two folders apart", () => {
    expect(viewKey("C:\\A", "x.md")).not.toBe(viewKey("C:\\B", "x.md"));
    expect(viewKey("C:\\A", "x.md")).toBe(viewKey("c:/a", "x.md"));
  });
});
