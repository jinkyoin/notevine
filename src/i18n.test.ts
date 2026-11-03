import { describe, expect, it } from "vitest";
import en from "./i18n/en.json";
import { setLangForTest, tx } from "./i18n";

const SOURCES = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every tx("…") key written in the source. */
function sourceKeys(): Set<string> {
  const keys = new Set<string>();
  for (const text of Object.values(SOURCES)) {
    for (const m of text.matchAll(/\btx\(\s*("(?:[^"\\]|\\.)*")/g)) keys.add(JSON.parse(m[1]));
  }
  return keys;
}

describe("i18n", () => {
  it("fills values and falls back to Korean", () => {
    setLangForTest("en");
    expect(tx("노트 {0}개에 적용했습니다 · 히스토리에서 되돌릴 수 있습니다", 3)).toBe("Applied to 3 notes · You can undo it from History");
    expect(tx("아직 없는 문장 {0}", "x")).toBe("아직 없는 문장 x");
    setLangForTest("ko");
    expect(tx("노트 {0}개에 적용했습니다 · 히스토리에서 되돌릴 수 있습니다", 3)).toBe("노트 3개에 적용했습니다 · 히스토리에서 되돌릴 수 있습니다");
  });

  it("has English for every screen text, with the same value slots", () => {
    const table = en as Record<string, string>;
    const keys = [...sourceKeys()];
    const missing = keys.filter((k) => !(k in table));
    expect(missing).toEqual([]);
    const slots = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();
    const wrong = keys.filter((k) => k in table && slots(k) !== slots(table[k]));
    expect(wrong).toEqual([]);
    const stray = Object.keys(table).filter((k) => !keys.includes(k));
    expect(stray).toEqual([]);
  });
});
