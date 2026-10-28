// 앱 안 확인 대화상자. OS 대화상자와 달리 화면 테스트로도 누를 수 있다.
import { useApp } from "../store";

export function ConfirmDialog() {
  const c = useApp((s) => s.confirm);
  if (!c) return null;
  const answer = (v: boolean) => {
    useApp.setState({ confirm: null });
    c.resolve(v);
  };
  return (
    <div className="modal-backdrop" onMouseDown={() => answer(false)} onKeyDown={(e) => e.key === "Escape" && answer(false)}>
      <div className="modal" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{c.title}</h2>
        <p className="confirm-msg">{c.message}</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => answer(false)}>
            취소
          </button>
          <button className="btn primary" autoFocus onClick={() => answer(true)}>
            {c.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
