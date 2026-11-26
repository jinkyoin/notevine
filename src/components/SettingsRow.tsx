// SCR-16 설정의 한 줄: 이름(과 설명)과 오른쪽의 조작.
export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}
