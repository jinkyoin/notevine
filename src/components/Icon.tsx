// 선 아이콘 한 벌: 16px, 선 굵기 1.5, 색은 글자 색(currentColor)을 따른다. 상단바와 단추의 글자 기호를 대신한다.
import type { SVGProps } from "react";

const PATHS = {
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  command: "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3",
  settings: "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4",
  plus: "M12 5v14M5 12h14",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, ...rest }: { name: IconName } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
