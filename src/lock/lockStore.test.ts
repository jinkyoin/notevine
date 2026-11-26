// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockReason, LockStatus } from "../api";

const mocks = vi.hoisted(() => ({
  lockStatus: vi.fn(),
  flushEditor: vi.fn(),
  listeners: [] as ((e: { payload: unknown }) => void)[],
}));
vi.mock("../api", () => ({ api: { lockStatus: mocks.lockStatus } }));
vi.mock("../store", () => ({ useApp: { getState: () => ({ flushEditor: mocks.flushEditor }) } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, fn: (e: { payload: unknown }) => void) => {
    mocks.listeners.push(fn);
    return () => {};
  }),
}));

const status = (over: Partial<LockStatus> = {}): LockStatus => ({
  mode: "password",
  locked: false,
  reason: null,
  epoch: 0,
  away: false,
  idle_minutes: 5,
  ...over,
});
const locked = (reason: LockReason = "manual", epoch = 1) => status({ locked: true, reason, epoch });

let lock: typeof import("./lockStore");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.listeners.length = 0;
  mocks.flushEditor.mockResolvedValue(true);
  document.body.className = "";
  document.body.innerHTML = `<div id="root"><input id="note"></div>`;
  lock = await import("./lockStore");
});
afterEach(() => vi.useRealTimers());

describe("lock state in the page", () => {
  const note = () => document.querySelector<HTMLInputElement>("#note")!;
  const root = () => document.querySelector<HTMLElement>("#root")!;

  it("is covered until the status is known", () => {
    expect(lock.isCovered()).toBe(true);
    lock.applyLockStatus(status());
    expect(lock.isCovered()).toBe(false);
  });

  // Blurring ends a Korean composition, so its text is in the note before the save.
  it("on locking, blurs first and saves after", () => {
    vi.useFakeTimers();
    lock.applyLockStatus(status());
    const order: string[] = [];
    note().focus();
    note().addEventListener("blur", () => order.push("blur"));
    mocks.flushEditor.mockImplementation(async () => void order.push("flush"));
    lock.applyLockStatus(locked());
    expect(root().hasAttribute("inert")).toBe(true);
    expect(document.body.classList.contains("nv-locked")).toBe(true);
    vi.runAllTimers();
    expect(order).toEqual(["blur", "flush"]);
  });

  it("does not save again when a locked app locks for a new reason", () => {
    vi.useFakeTimers();
    lock.applyLockStatus(status());
    lock.applyLockStatus(locked("idle"));
    lock.applyLockStatus(locked("session", 2));
    vi.runAllTimers();
    expect(mocks.flushEditor).toHaveBeenCalledTimes(1);
  });

  it("restores focus on unlock and runs the latest deferred action per key once", () => {
    lock.applyLockStatus(status());
    note().focus();
    lock.applyLockStatus(locked());
    const a = vi.fn();
    const b = vi.fn();
    lock.whenUnlocked("memo", a);
    lock.whenUnlocked("memo", b);
    expect(b).not.toHaveBeenCalled();
    lock.useLock.setState({ quitHeld: true });
    lock.applyLockStatus(status({ epoch: 1 }));
    expect(document.activeElement).toBe(note());
    expect(root().hasAttribute("inert")).toBe(false);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
    expect(lock.useLock.getState().quitHeld).toBe(false);
    lock.applyLockStatus(locked("manual", 2));
    lock.applyLockStatus(status({ epoch: 2 }));
    expect(b).toHaveBeenCalledOnce();
  });

  it("runs an action at once while unlocked", () => {
    lock.applyLockStatus(status());
    const now = vi.fn();
    lock.whenUnlocked("open", now);
    expect(now).toHaveBeenCalledOnce();
  });

  it("is enabled only with a lock method", () => {
    expect(lock.lockEnabled()).toBe(false);
    lock.applyLockStatus(status({ mode: "off" }));
    expect(lock.lockEnabled()).toBe(false);
    lock.applyLockStatus(status({ mode: "hello" }));
    expect(lock.lockEnabled()).toBe(true);
  });

  it("never replaces a newer event with the older fetched status", async () => {
    let answer!: (s: LockStatus) => void;
    mocks.lockStatus.mockReturnValue(new Promise<LockStatus>((r) => (answer = r)));
    lock.startLockSync();
    expect(document.body.classList.contains("nv-locked")).toBe(true);
    await vi.waitFor(() => expect(mocks.lockStatus).toHaveBeenCalled());
    mocks.listeners[0]({ payload: locked() });
    answer(status());
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.useLock.getState().status?.locked).toBe(true);
  });

  it("stays covered and says so when the status can't be read", async () => {
    mocks.lockStatus.mockRejectedValue(new Error("x"));
    lock.startLockSync();
    await vi.waitFor(() => expect(lock.useLock.getState().failed).toBe(true));
    expect(lock.isCovered()).toBe(true);
  });

  it.each<[LockReason, boolean]>([
    ["start", true],
    ["hidden", true],
    ["session", true],
    ["sleep", true],
    ["manual", false],
    ["idle", false],
  ])("auto Hello prompt for %s: %s", (reason, expected) => {
    expect(lock.shouldAutoPrompt({ ...locked(reason), mode: "hello" }, true, null)).toBe(expected);
  });

  it("does not auto prompt while away, unseen, twice for one lock, or without Hello", () => {
    const s: LockStatus = { ...locked("start", 3), mode: "hello" };
    expect(lock.shouldAutoPrompt({ ...s, away: true }, true, null)).toBe(false);
    expect(lock.shouldAutoPrompt(s, false, null)).toBe(false);
    expect(lock.shouldAutoPrompt(s, true, 3)).toBe(false);
    expect(lock.shouldAutoPrompt(s, true, 2)).toBe(true);
    expect(lock.shouldAutoPrompt({ ...s, mode: "password" }, true, null)).toBe(false);
    expect(lock.shouldAutoPrompt({ ...s, locked: false }, true, null)).toBe(false);
  });
});
