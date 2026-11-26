import { describe, expect, it, vi } from "vitest";
import { createQuit, type QuitDeps } from "./quit";

const deps = (over: Partial<QuitDeps> = {}) => ({
  flush: vi.fn(async (): Promise<boolean | void> => true),
  locked: vi.fn(() => false),
  confirmDiscard: vi.fn(async () => false),
  holdLocked: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  ...over,
});

describe("quitting with edits that could not be saved", () => {
  it("quits without asking when everything is saved", async () => {
    const d = deps();
    expect(await createQuit(d)()).toBe("quit");
    expect(d.confirmDiscard).not.toHaveBeenCalled();
    expect(d.destroy).toHaveBeenCalledOnce();
  });

  it("stays open when a save failed and the user cancels", async () => {
    const d = deps({ flush: vi.fn(async () => false) });
    expect(await createQuit(d)()).toBe("held");
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("quits when the user chooses to discard", async () => {
    const d = deps({ flush: vi.fn(async () => false), confirmDiscard: vi.fn(async () => true) });
    expect(await createQuit(d)()).toBe("quit");
    expect(d.destroy).toHaveBeenCalledOnce();
  });

  it("holds without asking while locked", async () => {
    const d = deps({ flush: vi.fn(async () => false), locked: vi.fn(() => true) });
    expect(await createQuit(d)()).toBe("held");
    expect(d.holdLocked).toHaveBeenCalledOnce();
    expect(d.confirmDiscard).not.toHaveBeenCalled();
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("treats a thrown flush as a failed save", async () => {
    const d = deps({
      flush: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    expect(await createQuit(d)()).toBe("held");
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("ignores a second request while the first is asking", async () => {
    let answer!: (v: boolean) => void;
    const d = deps({
      flush: vi.fn(async () => false),
      confirmDiscard: vi.fn(() => new Promise<boolean>((r) => (answer = r))),
    });
    const quit = createQuit(d);
    const first = quit();
    await vi.waitFor(() => expect(d.confirmDiscard).toHaveBeenCalled());
    expect(await quit()).toBe("busy");
    answer(false);
    expect(await first).toBe("held");
    expect(d.confirmDiscard).toHaveBeenCalledOnce();
    // The next request asks again.
    const again = quit();
    await vi.waitFor(() => expect(d.confirmDiscard).toHaveBeenCalledTimes(2));
    answer(false);
    expect(await again).toBe("held");
  });
});
