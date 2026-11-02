import { describe, expect, it } from "vitest";
import type { VaultConfig } from "../api";
import { buildReview, period, reviewFolder, reviewName } from "./review";

const config = {
  preset_enabled: true,
  area_folder: "20.영역",
  archive_folder: "40.보관",
  journal_folder: "20.영역/업무일지",
  template_folder: "90.템플릿",
} as VaultConfig;

const at = (d: string) => new Date(`${d}T12:00:00`).getTime();
const row = (path: string, props: Record<string, string> = {}, mtime = at("2026-01-01")) => ({
  path,
  title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
  mtime,
  props,
});

describe("review periods", () => {
  it("uses Monday–Sunday ISO weeks and calendar months", () => {
    expect(period("week", new Date(2026, 10, 2))).toEqual({ from: "2026-11-02", to: "2026-11-08", label: "2026-W45" });
    expect(period("week", new Date(2026, 10, 8))).toEqual({ from: "2026-11-02", to: "2026-11-08", label: "2026-W45" });
    // 2027-01-01 is a Friday: its week is the last of 2026.
    expect(period("week", new Date(2027, 0, 1)).label).toBe("2026-W53");
    expect(period("month", new Date(2026, 1, 14))).toEqual({ from: "2026-02-01", to: "2026-02-28", label: "2026-02" });
  });

  it("names and places the note", () => {
    expect(reviewName("week", period("week", new Date(2026, 10, 2)))).toBe("2026-W45 주간 회고");
    expect(reviewFolder(config)).toBe("20.영역/회고");
    expect(reviewFolder({ ...config, preset_enabled: false })).toBe("회고");
  });
});

describe("review note", () => {
  const p = period("week", new Date(2026, 10, 4));
  const rows = [
    row("20.영역/업무일지/2026/2026-11-03.md", { type: "journal" }, at("2026-11-03")),
    row("20.영역/업무일지/2026/2026-10-30.md", { type: "journal" }, at("2026-11-03")),
    row("회의/주간 회의.md", { type: "meeting", created: "2026-11-04" }),
    row("10.프로젝트/이사/이사.md", { type: "project", status: "완료" }, at("2026-11-05")),
    row("10.프로젝트/웹/웹.md", { type: "project", status: "진행", deadline: "2026-12-01" }),
    row("40.보관/옛 일/옛 일.md", { type: "project", status: "진행" }),
    row("30.자료/아이디어/자동화.md", { type: "idea", status: "검토", created: "2026-11-06" }),
    row("30.자료/조사자료/도구.md", { type: "research", created: "2026-11-02" }),
    row("메모.md", {}, at("2026-11-07")),
    row("a/메모.md", {}, at("2026-11-07")),
    row("90.템플릿/회의록.md", { type: "meeting", created: "2026-11-04" }),
    row("20.영역/회고/2026-W44 주간 회고.md", { type: "review" }, at("2026-11-03")),
  ];
  const text = buildReview("week", p, rows, config, "2026-11-08");

  it("lists the period's notes by kind", () => {
    expect(text).toContain("type: review\nperiod: 2026-11-02 ~ 2026-11-08\ncreated: 2026-11-08");
    expect(text).toContain("# 2026년 45주차 주간 회고 (11/02 ~ 11/08)");
    expect(text).toContain("## 업무일지 (1)\n\n- [[2026-11-03]]\n");
    expect(text).toContain("## 회의록 (1)\n\n- [[주간 회의]]\n");
    expect(text).toContain("## 완료한 프로젝트 (1)\n\n- [[이사]]\n");
    expect(text).toContain("## 진행 중인 프로젝트 (1)\n\n- [[웹]] · 마감 2026-12-01\n");
    expect(text).toContain("## 새 아이디어 (1)\n\n- [[자동화]] · 검토\n");
    expect(text).toContain("## 새 자료 (1)\n\n- [[도구]]\n");
    // Two notes named 메모: the link uses the path.
    expect(text).toContain("## 그 밖에 고친 노트 (3)\n\n- [[2026-10-30]]\n- [[메모]]\n- [[a/메모]]\n");
    expect(text).not.toContain("회의록]]");
    expect(text).not.toContain("W44");
    expect(text).toContain("- 다음 주에 할 일: ");
  });

  it("says so when nothing happened", () => {
    expect(buildReview("month", period("month", new Date(2020, 0, 1)), rows, config, "2020-01-31")).toContain("이 기간에 쓰거나 고친 노트가 없습니다.");
  });
});
