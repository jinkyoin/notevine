// SCR-19 AI 전송 확인 + SCR-20 AI 작성 결과 미리보기.
import { useEffect, useState } from "react";
import { useAi } from "../aiStore";
import { PROVIDER_COMPANY } from "../ai";

export function AiSendConfirm() {
  const req = useAi((s) => s.send);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => setChecked(new Set(req?.checked ?? [])), [req]);
  if (!req) return null;

  const answer = (paths: string[] | null) => {
    useAi.setState({ send: null });
    req.resolve(paths);
  };
  const chosen = req.notes.filter((n) => checked.has(n.path));
  const chars = chosen.reduce((n, x) => n + x.chars, 0) + [...(req.extra?.text ?? "")].length;
  const toggle = (p: string) => {
    const next = new Set(checked);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setChecked(next);
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => answer(null)} onKeyDown={(e) => e.key === "Escape" && answer(null)}>
      <div className="modal ai-send" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{req.title}</h2>
        <p className="small">
          아래 내용을 <b>{req.provider.name}</b>를 통해 {PROVIDER_COMPANY[req.provider.id] ?? "AI 서비스"}로 보냅니다. 보내지
          않을 노트는 체크를 해제하세요.
        </p>
        {req.extra && (
          <div className="ai-extra">
            <div className="muted small">{req.extra.label}</div>
            <div className="ai-extra-text">{req.extra.text}</div>
          </div>
        )}
        {req.notes.length > 0 ? (
          <ul className="change-list ai-notes">
            {req.notes.map((n) => (
              <li key={n.path}>
                <label>
                  <input type="checkbox" checked={checked.has(n.path)} onChange={() => toggle(n.path)} />
                  <span className="ai-note-title" title={n.path}>
                    {n.title}
                  </span>
                  <span className="muted small">{n.chars.toLocaleString()}자</span>
                </label>
                {n.snippet && <div className="muted small ai-snippet">{n.snippet}</div>}
              </li>
            ))}
          </ul>
        ) : (
          req.extra === undefined && <p className="muted small">보낼 노트가 없습니다.</p>
        )}
        <p className="muted small">
          보낼 분량: 노트 {chosen.length}개 · 약 {chars.toLocaleString()}자
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => answer(null)}>
            취소
          </button>
          <button className="btn primary" autoFocus onClick={() => answer(chosen.map((n) => n.path))}>
            보내기
          </button>
        </div>
      </div>
    </div>
  );
}

export function AiPreview() {
  const p = useAi((s) => s.preview);
  const { closePreview, applyPreview } = useAi.getState();
  const [draft, setDraft] = useState("");
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setDraft(p?.result ?? "");
  }, [p?.result, edited]);
  useEffect(() => {
    if (!p) setEdited(false);
  }, [p]);
  if (!p) return null;

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === "Escape" && closePreview()}>
      <div className="modal ai-preview" role="dialog" aria-modal="true">
        <div className="vv-head">
          <h2>{p.title}</h2>
          <button className="icon-btn" title="닫기 (Esc)" onClick={closePreview}>
            ×
          </button>
        </div>
        <div className={p.mode === "edit" ? "ai-compare" : "ai-single"}>
          {p.mode === "edit" && (
            <div>
              <div className="muted small">원문</div>
              <pre className="ai-original">{p.original}</pre>
            </div>
          )}
          <div>
            <div className="muted small">
              결과 {p.streaming ? "· 작성 중…" : "· 고쳐 쓸 수 있습니다"}
            </div>
            <textarea
              className="ai-result"
              value={draft}
              readOnly={p.streaming}
              onChange={(e) => {
                setEdited(true);
                setDraft(e.target.value);
              }}
            />
          </div>
        </div>
        {p.error && <p className="error small">{p.error}</p>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={closePreview}>
            {p.streaming ? "중지" : "취소"}
          </button>
          {p.mode === "edit" ? (
            <>
              <button className="btn" disabled={p.streaming || !draft.trim()} onClick={() => void applyPreview("below", draft)}>
                아래에 넣기
              </button>
              <button className="btn primary" disabled={p.streaming || !draft.trim()} onClick={() => void applyPreview("replace", draft)}>
                바꾸기
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={p.streaming || !draft.trim()} onClick={() => void applyPreview("note", draft)}>
              새 노트로 만들기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
