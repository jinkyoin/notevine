import { describe, expect, it } from "vitest";
import { formatRecoveryInput } from "./recoveryCode";

describe("formatRecoveryInput", () => {
  it("uppercases and puts a dash every 6 characters", () => {
    expect(formatRecoveryInput("abcdefghij")).toBe("ABCDEF-GHIJ");
  });
  it("ignores spaces and dashes", () => {
    expect(formatRecoveryInput("abc def-ghi j")).toBe("ABCDEF-GHIJ");
    expect(formatRecoveryInput("ABCDEF-GHIJKL-MNO")).toBe("ABCDEF-GHIJKL-MNO");
  });
  it("is empty for empty input", () => {
    expect(formatRecoveryInput(" - ")).toBe("");
  });
});
