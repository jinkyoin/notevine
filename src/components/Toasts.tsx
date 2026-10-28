// SCR-17 알림: 오른쪽 아래. 정보는 4초 뒤 사라지고 오류는 닫을 때까지 남는다.
import { useApp } from "../store";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.message}</span>
          <button className="icon-btn" title="닫기" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
