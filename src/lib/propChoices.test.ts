import { describe, expect, it } from "vitest";
import { choiceKey, choiceOptions, TYPE_CHOICES } from "./propChoices";

describe("choiceKey", () => {
  it("knows type and status, in any case", () => {
    expect(choiceKey("type")).toBe("type");
    expect(choiceKey("Status")).toBe("status");
    expect(choiceKey("date")).toBeNull();
  });
});

describe("choiceOptions", () => {
  const statuses = ["아이디어", "검토", "진행", "완료", "보류"];

  it("offers every known type, then other values in the vault, then the current one", () => {
    const opts = choiceOptions("type", "memo", ["idea", "책", "memo"], statuses);
    expect(opts.map((o) => o.value)).toEqual([...TYPE_CHOICES.map((c) => c.value), "책", "memo"]);
    expect(opts[0]).toEqual({ value: "idea", label: "idea · 아이디어" });
  });

  it("offers the note folder's statuses for status", () => {
    const opts = choiceOptions("status", "", ["진행", "대기"], statuses);
    expect(opts.map((o) => o.value)).toEqual([...statuses, "대기"]);
    expect(opts[0]).toEqual({ value: "아이디어", label: "아이디어" });
  });

  it("drops blank and repeated values", () => {
    const opts = choiceOptions("status", "검토", [" ", "검토", "검토"], statuses);
    expect(opts.map((o) => o.value)).toEqual(statuses);
  });
});
