// 앱 잠금 상태. 원본은 Rust에 있고 화면은 `lock-changed`를 받아 따른다 (NFR-SEC-04).
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, type LockStatus } from "../api";
import { useApp } from "../store";
import { setCovered } from "./cover";

interface LockStore {
  /** null until the app has told us. */
  status: LockStatus | null;
  /** A quit was refused because something could not be saved. */
  quitHeld: boolean;
  /** The status could not be read. */
  failed: boolean;
}

export const useLock = create<LockStore>(() => ({ status: null, quitHeld: false, failed: false }));

type Deferred = "memo" | "open";
const waiting = new Map<Deferred, () => void>();

/** True while nothing of the app may be seen or used: locked, or not known yet. */
export function isCovered(): boolean {
  const s = useLock.getState().status;
  return !s || s.locked;
}

/** Whether a lock method is set. */
export function lockEnabled(): boolean {
  const s = useLock.getState().status;
  return !!s && s.mode !== "off";
}

export function applyLockStatus(next: LockStatus) {
  const before = useLock.getState().status;
  setCovered(next.locked);
  useLock.setState({ status: next, failed: false, ...(next.locked ? {} : { quitHeld: false }) });
  if (next.locked) {
    // A moment later: ending a composition has put its text in the editor by then.
    if (before && !before.locked) setTimeout(() => void useApp.getState().flushEditor(), 0);
    return;
  }
  const run = [...waiting.values()];
  waiting.clear();
  for (const f of run) f();
}

/** Runs `fn` now, or once the app is unlocked; only the latest one of each kind waits. */
export function whenUnlocked(key: Deferred, fn: () => void) {
  if (isCovered()) waiting.set(key, fn);
  else fn();
}

/** Follows the app's lock state; returns how to stop. */
export function startLockSync(): () => void {
  setCovered(isCovered());
  let heard = false;
  const off = listen<LockStatus>("lock-changed", ({ payload }) => {
    heard = true;
    applyLockStatus(payload);
  });
  // Listening first: an answer older than an event already heard is dropped.
  void off
    .then(() => api.lockStatus())
    .then((s) => {
      if (!heard) applyLockStatus(s);
    })
    .catch(() => {
      if (!heard) useLock.setState({ failed: true });
    });
  return () => void off.then((f) => f()).catch(() => {});
}

/**
 * Windows Hello asks by itself only when the user is coming back, once per lock:
 * not right after "lock now" (a face would open it again at once), nor when idle (nobody is there).
 */
export function shouldAutoPrompt(s: LockStatus, shown: boolean, promptedEpoch: number | null): boolean {
  return (
    s.locked &&
    s.mode === "hello" &&
    !s.away &&
    shown &&
    s.epoch !== promptedEpoch &&
    (s.reason === "start" || s.reason === "hidden" || s.reason === "session" || s.reason === "sleep")
  );
}
