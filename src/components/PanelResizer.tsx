// 사이드바 폭 조절: 왼쪽 사이드바는 오른쪽 가장자리, 오른쪽 패널은 왼쪽 가장자리를 끌어
// 넓히거나 좁힌다. 두 번 누르면 처음 폭으로. 폭은 이 PC에 기억한다(노트 폴더와 상관없음).
import { useEffect, useRef } from "react";
import { tx } from "../i18n";

type Side = "left" | "right";

const SPEC: Record<Side, { key: string; cssVar: string; def: number; min: number }> = {
  left: { key: "notevine.sidebarWidth", cssVar: "--sidebar-w", def: 260, min: 180 },
  // The AI assistant needs room for its selectors and input.
  right: { key: "notevine.rightWidth", cssVar: "--right-w", def: 300, min: 240 },
};
export const SIDEBAR_DEFAULT = SPEC.left.def;
/** Space the note in the middle always keeps. */
const CENTER_MIN = 400;

function current(side: Side): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(SPEC[side].cssVar));
  return v > 0 ? v : SPEC[side].def;
}

/** The widest a panel may get: 600px, half the window, and room left for the note and the other panel. */
function maxWidth(side: Side): number {
  const other = side === "left" ? "right" : "left";
  const otherShown = !!document.querySelector(other === "left" ? ".sidebar" : ".rightpanel");
  const room = window.innerWidth - CENTER_MIN - (otherShown ? current(other) : 0);
  return Math.max(SPEC[side].min, Math.min(600, Math.floor(window.innerWidth / 2), room));
}

export function clampPanel(w: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, w)));
}

/** Left sidebar width kept between 180px and `max`. */
export function clampSidebar(w: number, max = 600): number {
  return clampPanel(w, SPEC.left.min, max);
}

function apply(side: Side, w: number) {
  document.documentElement.style.setProperty(SPEC[side].cssVar, `${w}px`);
}

function save(side: Side, w: number) {
  try {
    if (w === SPEC[side].def) localStorage.removeItem(SPEC[side].key);
    else localStorage.setItem(SPEC[side].key, String(w));
  } catch {
    // no storage: the width lasts until the window closes
  }
}

function stored(side: Side): number {
  try {
    const v = Number(localStorage.getItem(SPEC[side].key));
    return v > 0 ? v : SPEC[side].def;
  } catch {
    return SPEC[side].def;
  }
}

/** The drag handle on the inner edge of a side panel. */
export function PanelResizer({ side }: { side: Side }) {
  const spec = SPEC[side];
  const width = useRef(stored(side));
  const set = (w: number) => {
    width.current = clampPanel(w, spec.min, maxWidth(side));
    apply(side, width.current);
  };

  useEffect(() => {
    set(width.current);
    // A smaller window can't keep a panel this wide.
    const fit = () => set(width.current);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dragging right widens the left sidebar but narrows the right panel.
  const dir = side === "left" ? 1 : -1;

  return (
    <div
      className={`panel-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? tx("사이드바 폭") : tx("오른쪽 패널 폭")}
      aria-valuenow={width.current}
      tabIndex={0}
      title={tx("끌어서 폭 바꾸기 · 두 번 누르면 처음 폭")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startW = width.current;
        document.body.classList.add("resizing");
        el.classList.add("active");
        const move = (ev: PointerEvent) => set(startW + dir * (ev.clientX - startX));
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          document.body.classList.remove("resizing");
          el.classList.remove("active");
          save(side, width.current);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => {
        set(spec.def);
        save(side, width.current);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        // The arrow moves the edge: → widens the left sidebar, narrows the right panel.
        if (e.key === "ArrowLeft") set(width.current - dir * step);
        else if (e.key === "ArrowRight") set(width.current + dir * step);
        else return;
        e.preventDefault();
        save(side, width.current);
      }}
    />
  );
}
