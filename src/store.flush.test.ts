import { describe, expect, it } from "vitest";
import { useApp } from "./store";

describe("a second question while one is on screen", () => {
  // The quit question waits for its answer: if it is never settled, the app can't quit any more.
  it("answers the first one no", async () => {
    const first = useApp.getState().ask("a", "m", "ok");
    const second = useApp.getState().ask("b", "m", "ok");
    expect(await first).toBe(false);
    expect(useApp.getState().confirm?.title).toBe("b");
    useApp.getState().confirm!.resolve(true);
    expect(await second).toBe(true);
  });
});

describe("flushing both editors", () => {
  it("reports false when either editor could not save", async () => {
    useApp.getState().setFlushEditor(async () => true);
    useApp.getState().setFlushEditor(async () => false, true);
    expect(await useApp.getState().flushEditor(true)).toBe(false);
    useApp.getState().setFlushEditor(async () => {}, true);
    expect(await useApp.getState().flushEditor(true)).toBe(true);
  });
});
