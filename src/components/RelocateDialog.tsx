// SCR-15 이름 변경·이동 확인: 링크가 바뀔 노트를 보여 주고 갱신 여부를 고른다 (FR-LNK-05).
import { useEffect } from "react";
import { useApp } from "../store";
import { baseName } from "../lib/tree";

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
  const verb = pending.kind === "rename" ? `"${pending.arg}"(으)로 이름을 바꾸면` : `"${pending.arg || "맨 위 폴더"}"(으)로 옮기면`;

  return (
    <div className="modal-backdrop" onMouseDown={() => confirm(null)}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h2>링크도 함께 고칠까요?</h2>
        <p>
          "{what}"을(를) {verb} 노트 {pending.changes.length}개의 링크 {total}개가 바뀝니다.
        </p>
        <ul className="change-list">
          {pending.changes.map((c) => (
            <li key={c.path} title={c.path}>
              <span>{c.title}</span>
              <span className="muted small">링크 {c.count}개</span>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => confirm(null)}>
            취소
          </button>
          <button className="btn" onClick={() => confirm(false)}>
            링크는 그대로
          </button>
          <button className="btn primary" autoFocus onClick={() => confirm(true)}>
            링크 {total}개 고치기
          </button>
        </div>
      </div>
    </div>
  );
}
