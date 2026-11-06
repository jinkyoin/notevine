import { afterEach, describe, expect, it } from "vitest";
import { registerAppCommands } from "./appCommands";
import { availableCommands } from "./commands";
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
