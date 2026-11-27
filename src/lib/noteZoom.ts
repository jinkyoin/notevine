// 노트 본문 확대·축소: 노트 위에서 Ctrl+휠. 글자 크기만 바뀌고 사이드바·메뉴는 그대로다.
// 배율은 이 PC에 기억한다(노트 폴더와 상관없음).

const KEY = "notevine.noteZoom";
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
export const ZOOM_STEP = 10;
export const ZOOM_DEFAULT = 100;
/** Wheel movement that makes one step: one notch of a mouse wheel is 100. */
const NOTCH = 100;
/** A line-based wheel reports lines, not pixels; its notch is usually 3 lines. */
const LINE_PX = 40;

/** Whole percent between 50 and 300 in steps of 10. */
export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return ZOOM_DEFAULT;
  const snapped = Math.round(percent / ZOOM_STEP) * ZOOM_STEP;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, snapped));
}

/**
 * Turns wheel movement into zoom steps (positive zooms in: the wheel rolls away from you).
 * `rest` is what is left over; a trackpad sends many small movements that add up to a step.
 */
export function wheelSteps(carried: number, deltaY: number, deltaMode: number): { steps: number; rest: number } {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaY;
  const total = carried - px;
  const steps = Math.trunc(total / NOTCH);
  return { steps, rest: total - steps * NOTCH };
}

export function loadNoteZoom(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v > 0 ? clampZoom(v) : ZOOM_DEFAULT;
  } catch {
    return ZOOM_DEFAULT;
  }
}

let current: number | null = null;
const listeners = new Set<() => void>();

/** Runs `fn` after the text size changed (an editor measures its lines again). Returns how to stop. */
export function onNoteZoom(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Shows the note text at `percent` and remembers it. */
export function applyNoteZoom(percent: number): number {
  const p = clampZoom(percent);
  const changed = p !== current;
  current = p;
  document.documentElement.style.setProperty("--note-zoom", String(p / 100));
  try {
    if (p === ZOOM_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(p));
  } catch {
    // no storage: the size lasts until the window closes
  }
  if (changed) for (const fn of [...listeners]) fn();
  return p;
}

/** Ctrl+wheel on `el` zooms the note text. A plain wheel is left alone so the note still scrolls. Returns how to stop. */
export function installNoteZoom(el: HTMLElement): () => void {
  let carried = 0;
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    // Without this the whole page would zoom, sidebar and menus too.
    e.preventDefault();
    const { steps, rest } = wheelSteps(carried, e.deltaY, e.deltaMode);
    carried = rest;
    if (steps === 0) return;
    const from = current ?? loadNoteZoom();
    applyNoteZoom(from + steps * ZOOM_STEP);
  };
  // Not passive: a passive listener cannot stop the page zoom.
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => el.removeEventListener("wheel", onWheel);
}
