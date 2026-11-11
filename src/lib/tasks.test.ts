import { describe, expect, it } from "vitest";
import type { TaskItem } from "../api";
import { groupTasks, taskLabel, toggleTaskLine } from "./tasks";

const task = (over: Partial<TaskItem>): TaskItem => ({
  path: "a.md",
  title: "a",
  line: 1,
  done: false,
  text: "x",
  due: null,
  mtime: 0,
  ...over,
});

describe("toggleTaskLine", () => {
  const text = "# 할 일\n- [ ] 보고서 쓰기\n  * [x] 자료 모으기\n> 1. [ ] 인용\n";

  it("flips the box on that line", () => {
    expect(toggleTaskLine(text, 2, "보고서 쓰기")).toBe("# 할 일\n- [x] 보고서 쓰기\n  * [x] 자료 모으기\n> 1. [ ] 인용\n");
    expect(toggleTaskLine(text, 3, "자료 모으기")).toBe("# 할 일\n- [ ] 보고서 쓰기\n  * [ ] 자료 모으기\n> 1. [ ] 인용\n");
    expect(toggleTaskLine(text, 4, "인용")).toBe("# 할 일\n- [ ] 보고서 쓰기\n  * [x] 자료 모으기\n> 1. [x] 인용\n");
  });

  it("refuses when the line is no longer that task", () => {
    expect(toggleTaskLine(text, 1, "보고서 쓰기")).toBeNull();
    expect(toggleTaskLine(text, 2, "다른 일")).toBeNull();
    expect(toggleTaskLine(text, 9, "보고서 쓰기")).toBeNull();
  });

  it("keeps CRLF line ends", () => {
    expect(toggleTaskLine("a\r\n- [ ] 일\r\n", 2, "일")).toBe("a\r\n- [x] 일\r\n");
  });
});

describe("taskLabel", () => {
  it("drops the due date mark", () => {
    expect(taskLabel("보고서 쓰기 📅 2026-11-12")).toBe("보고서 쓰기");
    expect(taskLabel("📅 2026-11-12 보고서")).toBe("보고서");
    expect(taskLabel("그냥 할 일")).toBe("그냥 할 일");
  });
});

describe("groupTasks", () => {
  it("sorts open tasks by due date against today and puts done ones last", () => {
    const groups = groupTasks(
      [
        task({ text: "지남", due: "2026-11-10" }),
        task({ text: "오늘", due: "2026-11-11" }),
        task({ text: "다가옴", due: "2026-11-20" }),
        task({ text: "없음" }),
        task({ text: "끝", done: true, due: "2026-11-01" }),
      ],
      "2026-11-11",
    );
    expect(groups.map((g) => [g.key, g.items.map((t) => t.text)])).toEqual([
      ["overdue", ["지남"]],
      ["today", ["오늘"]],
      ["upcoming", ["다가옴"]],
      ["none", ["없음"]],
      ["done", ["끝"]],
    ]);
  });

  it("leaves out empty groups", () => {
    expect(groupTasks([task({ text: "없음" })], "2026-11-11").map((g) => g.key)).toEqual(["none"]);
  });
});
