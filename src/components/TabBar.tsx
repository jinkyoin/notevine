// 편집기 위 탭 막대 (FR-EDT-07). 누르면 그 노트로, ×나 가운데 버튼으로 닫는다.
import { useEffect, useRef, useState } from "react";
import { useApp, type OpenOpts } from "../store";
import { noteTitle } from "../lib/tree";

import { tx } from "../i18n";
/**
 * Click handlers for anything that opens a note: a plain click opens it in the current
 * tab, Ctrl+click or a middle click in a new tab (as in a browser).
 */
export function openProps(open: (opts: OpenOpts) => void) {
  return {
    onClick: (e: React.MouseEvent) => open({ newTab: e.ctrlKey || e.metaKey }),
    // Stop the middle button's scroll mode, then open on its click.
    onMouseDown: (e: React.MouseEvent) => e.button === 1 && e.preventDefault(),
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      open({ newTab: true });
    },
  };
}

interface Menu {
  x: number;
  y: number;
  path: string;
}

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.openPath);
  const bar = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  // Keep the tab on screen in view when there are more tabs than fit.
  useEffect(() => {
    bar.current?.querySelector<HTMLElement>(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

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

  if (!tabs.length) return null;
  const { openNote, closeTab, closeOtherTabs } = useApp.getState();

  return (
    <div className="tabbar" role="tablist" ref={bar}>
      {tabs.map((t) => (
        <div
          key={t.path}
          role="tab"
          aria-selected={t.path === active}
          className={`tab${t.path === active ? " on" : ""}`}
          title={t.path}
          // The active tab is clickable too while a folder table covers its note.
          onClick={() => (t.path !== active || useApp.getState().tableView !== null) && openNote(t.path)}
          // Middle click closes, as in a browser.
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            closeTab(t.path);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, path: t.path });
          }}
        >
          <span className="tab-label">{noteTitle(t.path)}</span>
          <button
            className="tab-close"
            aria-label={tx("{0} 탭 닫기", noteTitle(t.path))}
            title={tx("탭 닫기 (Ctrl+W)")}
            onClick={(e) => {
              e.stopPropagation();
              closeTab(t.path);
            }}
          >
            ×
          </button>
        </div>
      ))}
      {menu && (
        <ul className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {(
            [
              [tx("탭 닫기"), () => closeTab(menu.path)],
              [tx("다른 탭 모두 닫기"), () => closeOtherTabs(menu.path)],
              // The note on screen can't also be edited on the right.
              ...(menu.path !== active
                ? ([[tx("오른쪽에 나란히 열기"), () => useApp.getState().openSplit(menu.path)]] as [string, () => void][])
                : []),
            ] as [string, () => void][]
          ).map(([label, run]) => (
            <li
              key={label}
              onClick={() => {
                setMenu(null);
                run();
              }}
            >
              {label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
