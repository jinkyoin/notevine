// 끝내기 전에 저장을 확인한다. 저장하지 못한 편집이 있으면 바로 끝내지 않는다:
// 풀린 상태에서는 묻고, 잠긴 상태에서는 보류한다 (NFR-SEC-04).

export interface QuitDeps {
  /** Saves the open notes; false (or a throw) means something could not be saved. */
  flush(): Promise<boolean | void>;
  locked(): boolean;
  /** Asks whether to quit and lose the unsaved edits. */
  confirmDiscard(): Promise<boolean>;
  /** Tells, over the lock screen, that the app did not quit. */
  holdLocked(): Promise<void>;
  destroy(): Promise<void>;
}

/** One quit at a time: a second request while one is deciding does nothing. */
export function createQuit(deps: QuitDeps): () => Promise<"quit" | "held" | "busy"> {
  let busy = false;
  return async () => {
    if (busy) return "busy";
    busy = true;
    try {
      const saved = await deps.flush().then(
        (r) => r !== false,
        () => false,
      );
      if (!saved) {
        if (deps.locked()) {
          await deps.holdLocked();
          return "held";
        }
        if (!(await deps.confirmDiscard())) return "held";
      }
      await deps.destroy();
      return "quit";
    } finally {
      busy = false;
    }
  };
}
