import { describe, expect, it } from "vitest";
import { attachmentLink, pastedImageName } from "./attachments";

describe("attachments", () => {
  it("names pasted images by time", () => {
    expect(pastedImageName(new Date(2026, 9, 28, 14, 32, 1))).toBe("이미지 20261028-143201.png");
    expect(pastedImageName(new Date(2026, 0, 2, 3, 4, 5), "jpg")).toBe("이미지 20260102-030405.jpg");
  });

  it("embeds images and links other files", () => {
    expect(attachmentLink("첨부/구조도.PNG")).toBe("![[첨부/구조도.PNG]]");
    expect(attachmentLink("첨부/견적서.xlsx")).toBe("[[첨부/견적서.xlsx]]");
  });
});
