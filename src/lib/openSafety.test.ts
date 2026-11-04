import { describe, expect, it } from "vitest";
import { opensWithoutAsking } from "./openSafety";

describe("opensWithoutAsking", () => {
  it.each(["자료/견적서.xlsx", "보고.DOCX", "회의.hwp", "표.csv", "사진.png", "녹음.mp3", "묶음.zip"])("opens documents and media: %s", (p) => {
    expect(opensWithoutAsking(p)).toBe(true);
  });

  it.each([
    "회의록.bat",
    "회의록.cmd",
    "setup.exe",
    "바로가기.lnk",
    "링크.url",
    "x.hta",
    "x.ps1",
    "x.vbs",
    "x.js",
    "x.msi",
    "x.scr",
    "x.html",
    "매크로.docm",
    "매크로.xlsm",
  ])("asks before anything that can run code: %s", (p) => {
    expect(opensWithoutAsking(p)).toBe(false);
  });

  it.each(["견적서.xlsx.exe", "견적서.xlsx.", "견적서.xlsx ", "견적서.xlsx::$DATA", "확장자없음", ""])("is not fooled by the name: %j", (p) => {
    expect(opensWithoutAsking(p)).toBe(false);
  });
});
