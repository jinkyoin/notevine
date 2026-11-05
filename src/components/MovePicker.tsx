// 파일 탐색기 우클릭 메뉴의 '다른 폴더로 이동': 폴더를 찾아 고르면 끌어다 놓기와 같은 경로로 옮긴다.
import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { baseName, moveTargets } from "../lib/tree";

import { tx } from "../i18n";
export function MovePicker({ path, close }: { path: string; close: () => void }) {
  const tree = useApp((s) => s.tree);
  const move = useApp((s) => s.move);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  // The top of the vault has no name to search for: it is listed until a search starts.
  const options = moveTargets(tree, path).filter((t) => (t ? t.toLowerCase().includes(q) : !q));

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const to = options[i];
    if (to === undefined) return;
    close();
    void move(path, to);
  };

  return (
    <div className="modal-backdrop top" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="memo-head">
          {tx("'{0}' 옮기기", baseName(path).replace(/\.md$/i, ""))} <span className="muted small">{tx("↑↓ 선택 · Enter")}</span>
        </div>
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder={tx("옮길 폴더 찾기")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, options.length - 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            else if (e.key === "Enter") choose(sel);
            else return;
            e.preventDefault();
          }}
        />
        <ul className="palette-list" ref={list}>
          {options.map((t, i) => (
            <li key={t || "/"} className={i === sel ? "sel" : ""} title={t} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
              {t || tx("노트 폴더 맨 위")}
            </li>
          ))}
          {options.length === 0 && <li className="muted small">{tx("옮길 수 있는 폴더가 없습니다")}</li>}
        </ul>
      </div>
    </div>
  );
}
