import { describe, expect, it } from "vitest";
import { suggestFolderName } from "./cloneName";

describe("suggestFolderName", () => {
  it("takes the last path segment without .git", () => {
    expect(suggestFolderName("https://github.com/me/notes.git")).toBe("notes");
    expect(suggestFolderName("https://github.com/me/notes/")).toBe("notes");
    expect(suggestFolderName("git@github.com:me/my-vault.git")).toBe("my-vault");
    expect(suggestFolderName("C:\\repos\\vault.git")).toBe("vault");
    expect(suggestFolderName("  ")).toBe("");
  });
});
