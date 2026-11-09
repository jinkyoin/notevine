// 노트 폴더 막대 (FR-VLT-07): 창 왼쪽 끝에 열어 둔 노트 폴더를 첫 글자 단추로 둔다.
// 누르면 그 폴더로 바꾸고, 오른쪽 클릭으로 순서 바꾸기·탐색기에서 열기·닫기.
import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp } from "../store";
import { railLetter, samePath } from "../lib/rail";
import { PopupMenu } from "./PopupMenu";
import { tx } from "../i18n";

interface Menu {
  x: number;
  y: number;
  path: string;
  temp: boolean;
}

export function VaultRail() {
  const rail = useApp((s) => s.rail);
  const vault = useApp((s) => s.vault);
  const tempVault = useApp((s) => s.tempVault);
  const switching = useApp((s) => s.switching);
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const { switchVault, closeRailVault, pinTempVault, moveRail, setAdding } = useApp.getState();
  const shown = (path: string) => !!vault && samePath(vault.root, path);
  const temp = tempVault && vault && samePath(tempVault, vault.root) ? vault : null;

  const button = (path: string, name: string, i: number | null) => (
    <button
      key={path}
      className={`rail-btn${shown(path) ? " on" : ""}${i === null ? " temp" : ""}${switching && samePath(switching, path) ? " pending" : ""}`}
      aria-label={name}
      aria-current={shown(path) || undefined}
      aria-busy={(switching && samePath(switching, path)) || undefined}
      title={[name, path, i === null ? tx("잠깐 연 폴더") : i < 9 ? `Ctrl+${i + 1}` : ""].filter(Boolean).join("\n")}
      onClick={() => void switchVault(path)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, path, temp: i === null });
      }}
    >
      {railLetter(name)}
    </button>
  );

  const at = menu ? rail.findIndex((e) => samePath(e.path, menu.path)) : -1;
  const items: [string, (() => void) | null, string?][] = !menu
    ? []
    : menu.temp
      ? [
          [tx("막대에 추가"), () => void pinTempVault()],
          [tx("탐색기에서 노트 폴더 열기"), () => void revealItemInDir(menu.path).catch(() => {})],
          ["-", null],
          [tx("닫기"), () => void closeRailVault(menu.path)],
        ]
      : [
          [tx("위로 옮기기"), at > 0 ? () => void moveRail(menu.path, -1) : null],
          [tx("아래로 옮기기"), at >= 0 && at < rail.length - 1 ? () => void moveRail(menu.path, 1) : null],
          [tx("탐색기에서 노트 폴더 열기"), () => void revealItemInDir(menu.path).catch(() => {})],
          ["-", null],
          [tx("막대에서 닫기"), () => void closeRailVault(menu.path)],
        ];

  return (
    <nav className="rail" aria-label={tx("노트 폴더 막대")}>
      <div className="rail-list">
        {rail.map((e, i) => button(e.path, e.name, i))}
        {temp && button(temp.root, temp.name, null)}
        <button className="rail-btn add" aria-label={tx("노트 폴더 더 열기")} title={tx("노트 폴더 더 열기")} onClick={() => setAdding(true)}>
          ＋
        </button>
      </div>
      {menu && (
        <PopupMenu x={menu.x} y={menu.y}>
          {items.map(([label, run], i) =>
            label === "-" ? (
              <li key={`sep${i}`} className="menu-sep" role="separator" />
            ) : (
              <li
                key={label}
                className={run ? "" : "disabled"}
                aria-disabled={!run || undefined}
                onClick={() => {
                  if (!run) return;
                  setMenu(null);
                  run();
                }}
              >
                {label}
              </li>
            ),
          )}
        </PopupMenu>
      )}
    </nav>
  );
}
