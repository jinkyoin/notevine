import { describe, expect, it } from "vitest";
import { parseQuery } from "./query";

describe("parseQuery", () => {
  it("splits terms, phrases, tags and property filters", () => {
    expect(parseQuery('무개 "정확한 구" #업무개선 status:검토 type!=idea source=')).toEqual({
      text: ["무개", "정확한 구"],
      tags: ["업무개선"],
      props: [
        { key: "status", op: "eq", value: "검토" },
        { key: "type", op: "ne", value: "idea" },
        { key: "source", op: "empty", value: null },
      ],
    });
  });

  it("keeps URLs and a lone # as plain terms", () => {
    expect(parseQuery("https://a.com #").text).toEqual(["https://a.com", "#"]);
  });

  it("tolerates an unclosed quote and empty input", () => {
    expect(parseQuery('"반쯤 닫힌').text).toEqual(["반쯤 닫힌"]);
    expect(parseQuery("   ")).toEqual({ text: [], tags: [], props: [] });
  });
});
