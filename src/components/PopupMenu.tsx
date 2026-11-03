// 오른쪽 클릭 메뉴 틀: 누른 자리에 띄우고, 창 밖으로 나가면 위·왼쪽으로 옮긴다.
import { useRef } from "react";
import { useMenuPosition } from "../lib/menuPos";

export function PopupMenu({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const pos = useMenuPosition(ref, x, y);
  return (
    <ul className="menu" ref={ref} style={pos} onClick={(e) => e.stopPropagation()}>
      {children}
    </ul>
  );
}
