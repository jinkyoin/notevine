// SCR-15 이름 변경·이동 확인: 링크가 바뀔 노트를 보여 주고 갱신 여부를 고른다 (FR-LNK-05).
import { useEffect } from "react";
import { useApp } from "../store";
import { baseName } from "../lib/tree";

import { tx } from "../i18n";
export function RelocateDialog() {
  const pending = useApp((s) => s.pendingRelocate);
  const confirm = useApp((s) => s.confirmRelocate);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && confirm(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, confirm]);

  if (!pending) return null;
  const total = pending.changes.reduce((n, c) => n + c.count, 0);
  const what = baseName(pending.path).replace(/\.md$/i, "");
  const verb = pending.kind === "rename" ? tx("\"{0}\"(으)로 이름을 바꾸면", pending.arg) : tx("\"{0}\"(으)로 옮기면", pending.arg || tx("맨 위 폴더"));

  return (
    <div className="modal-backdrop" onMouseDown={() => confirm(null)}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{tx("링크도 함께 고칠까요?")}</h2>
        <p>
          {tx("\"{0}\"을(를) {1} 노트 {2}개의 링크 {3}개가 바뀝니다.", what, verb, pending.changes.length, total)}
        </p>
        <ul className="change-list">
          {pending.changes.map((c) => (
            <li key={c.path} title={c.path}>
              <span>{c.title}</span>
              <span className="muted small">{tx("링크 {0}개", c.count)}</span>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => confirm(null)}>
            {tx("취소")}
          </button>
          <button className="btn" onClick={() => confirm(false)}>
            {tx("링크는 그대로")}
          </button>
          <button className="btn primary" autoFocus onClick={() => confirm(true)}>
            {tx("링크 {0}개 고치기", total)}
          </button>
        </div>
      </div>
    </div>
  );
}
