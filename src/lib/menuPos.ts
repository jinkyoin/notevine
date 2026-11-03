// 오른쪽 클릭 메뉴 위치: 누른 자리에 띄우되 창 밖으로 나가지 않게 한다.
// 아래가 모자라면 위로 펼치고, 오른쪽이 모자라면 왼쪽으로 펼친다.
import { useLayoutEffect, useState, type RefObject } from "react";

const MARGIN = 8;

/** Top-left of a `w`×`h` menu opened at (`x`, `y`) in a `vw`×`vh` window, kept on screen. */
export function fitMenu(x: number, y: number, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  let left = x + w + MARGIN > vw ? x - w : x;
  let top = y + h + MARGIN > vh ? y - h : y;
  // Too big either way: as far in as it goes.
  left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
  return { left, top };
}

/** Style for a menu element at (`x`, `y`): measured once it is drawn, then moved on screen. */
export function useMenuPosition(ref: RefObject<HTMLElement | null>, x: number, y: number) {
  const [pos, setPos] = useState({ left: x, top: y, visibility: "hidden" as "hidden" | "visible" });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ ...fitMenu(x, y, width, height, window.innerWidth, window.innerHeight), visibility: "visible" });
  }, [ref, x, y]);
  return pos;
}
