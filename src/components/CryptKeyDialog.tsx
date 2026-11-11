// 설정 > 백업 > 암호화: 복구 코드 보여 주기(새 열쇠 / 다시 보기)와 복구 코드 입력.
import { useState } from "react";
import { api, errorMessage } from "../api";
import { formatRecoveryInput } from "../lib/recoveryCode";
import { tx } from "../i18n";

export type CryptKeyDialogMode =
  | { kind: "created"; code: string } // 방금 만든 열쇠: 보관했다고 확인해야 닫힌다
  | { kind: "show"; code: string }
  | { kind: "import" };

/** 복구 코드는 이 창 밖(로그·알림·상태)으로 내보내지 않는다. */
export function CryptKeyDialog({ mode, onClose }: { mode: CryptKeyDialogMode; onClose: (changed: boolean) => void }) {
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const doImport = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.cryptImportKey(input);
      onClose(true);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (mode.kind === "import") {
    return (
      <div className="modal-backdrop" onMouseDown={() => onClose(false)} onKeyDown={(e) => e.key === "Escape" && onClose(false)}>
        <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
          <h2>{tx("복구 코드 입력")}</h2>
          <p>{tx("다른 PC에서 만든 암호화 열쇠의 복구 코드를 입력하세요. 이 PC에 이미 다른 열쇠가 있으면 덮어쓰지 않습니다.")}</p>
          <input
            className="api-input recovery-input"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={input}
            placeholder="XXXXXX-XXXXXX-…"
            onChange={(e) => setInput(formatRecoveryInput(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && input && !busy && void doImport()}
          />
          {err && <p className="error small">{err}</p>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => onClose(false)}>
              {tx("취소")}
            </button>
            <button className="btn primary" disabled={busy || !input} onClick={() => void doImport()}>
              {tx("열쇠 넣기")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const created = mode.kind === "created";
  const canClose = !created || kept;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => canClose && onClose(created)}
      onKeyDown={(e) => e.key === "Escape" && canClose && onClose(created)}
    >
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{created ? tx("암호화 열쇠를 만들었습니다") : tx("복구 코드")}</h2>
        <p>
          {tx("이 복구 코드가 있어야 PC를 바꾸거나 이 PC의 열쇠를 잃었을 때 암호화된 백업을 풀 수 있습니다. 잃어버리면 백업을 되살릴 수 없으니 비밀번호 관리자나 종이에 보관하세요.")}
        </p>
        <code className="recovery-code" data-testid="recovery-code">
          {mode.code}
        </code>
        <div className="set-actions">
          <button className="btn small" onClick={() => void copy(mode.code)}>
            {copied ? tx("복사했습니다") : tx("복사")}
          </button>
        </div>
        {created && (
          <label className="small">
            <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} /> {tx("비밀번호 관리자나 종이에 보관했습니다")}
          </label>
        )}
        <div className="modal-actions">
          <button className="btn primary" disabled={!canClose} onClick={() => onClose(created)}>
            {tx("닫기")}
          </button>
        </div>
      </div>
    </div>
  );
}
