// 잠긴 동안 키 입력이 앱(단축키·편집기·대화상자)에 닿지 않게 한다. 다른 리스너보다 먼저 설치한다 (NFR-SEC-04).
import { isCovered } from "./lockStore";

const TYPES = ["keydown", "keyup", "keypress"] as const;

/** Held with Ctrl, these still work in the password box. */
const EDITING = new Set(["KeyA", "KeyC", "KeyV", "KeyX", "KeyY", "KeyZ", "Backspace", "Delete", "Insert", "Home", "End"]);

/**
 * Keys the browser would act on by itself (reload, print, save, back). On the lock screen
 * they are stopped too: a reload would lose the edits kept behind it.
 */
function browsersOwn(e: KeyboardEvent): boolean {
  if (e.key.startsWith("Browser")) return true;
  // Alt+F4 closes the window, which stays allowed.
  if (/^F\d+$/.test(e.key)) return !(e.key === "F4" && e.altKey);
  // Ctrl+Alt is AltGr: it types characters.
  if (e.altKey) return !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight");
  if (!e.ctrlKey && !e.metaKey) return false;
  return !EDITING.has(e.code) && !/^(Control|Shift|Meta|Arrow)/.test(e.code);
}

export function installKeyGuard(): () => void {
  const guard = (e: Event) => {
    if (!isCovered()) return;
    // No listener hears it, also not the lock screen's: it works by what the browser does
    // itself (typing, Enter submitting the form, buttons).
    e.stopImmediatePropagation();
    const onLock = e.target instanceof Element && e.target.closest(".lock-screen") !== null;
    if (!onLock || browsersOwn(e as KeyboardEvent)) e.preventDefault();
  };
  // The right-click menu offers a reload; the password box keeps its own (paste).
  const menu = (e: Event) => {
    if (isCovered() && !(e.target instanceof HTMLInputElement)) e.preventDefault();
  };
  for (const type of TYPES) window.addEventListener(type, guard, true);
  window.addEventListener("contextmenu", menu, true);
  return () => {
    for (const type of TYPES) window.removeEventListener(type, guard, true);
    window.removeEventListener("contextmenu", menu, true);
  };
}
