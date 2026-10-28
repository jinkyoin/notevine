// 삭제된 노트 히스토리 (FR-HIS-07): 파일은 없지만 히스토리가 남은 노트. 고르면 버전 보기에서 되살린다.
import { useEffect, useState } from "react";
import { api, type DeletedNote } from "../api";
import { useApp } from "../store";

export function DeletedNotes() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  const setVersionView = useApp((s) => s.setVersionView);
  const [items, setItems] = useState<DeletedNote[] | null>(null);

  useEffect(() => {
    if (modal !== "deleted") return;
    setItems(null);
    api.deletedNotes().then(setItems).catch(() => setItems([]));
  }, [modal]);

  if (modal !== "deleted") return null;
  const close = () => setModal(null);
  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="modal" tabIndex={-1} ref={(el) => el?.focus()} onMouseDown={(e) => e.stopPropagation()}>
        <h2>삭제된 노트 히스토리</h2>
        <p className="muted small">삭제했거나 다른 프로그램에서 지운 노트도 히스토리가 남아 있으면 되살릴 수 있습니다.</p>
        <ul className="change-list deleted-list">
          {items === null && <li className="muted">불러오는 중…</li>}
          {items?.length === 0 && <li className="muted">삭제된 노트가 없습니다.</li>}
          {items?.map((d) => (
            <li
              key={d.path}
              onClick={() => {
                close();
                setVersionView({ path: d.path, id: null });
              }}
              title={d.path}
            >
              <span>{d.title}</span>
              <span className="muted small">
                {new Date(d.last_saved_at).toLocaleDateString("ko-KR")} · 버전 {d.versions}개
              </span>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn" onClick={close}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
