// SCR-16 설정 > 일반 > 앱 잠금 (NFR-SEC-04). 켜진 잠금을 바꾸려면 지금 방식으로 본인 확인을 한다:
// 비밀번호는 여기서 받고, Windows Hello 확인 창은 앱(Rust)이 띄운다.
import { useRef, useState, type FormEvent } from "react";
import { api, errorMessage, type LockChange, type LockMode } from "../api";
import { Row } from "../components/SettingsRow";
import { tx } from "../i18n";
import { useLock } from "./lockStore";

const IDLE_MINUTES = [1, 5, 10, 30, 0];
const MIN_CHARS = 4;

export function LockSettings() {
  const status = useLock((s) => s.status);
  /** The change waiting for passwords, if one is. */
  const [pending, setPending] = useState<{ change: LockChange; newPassword: boolean } | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);

  if (!status || status.mode === "broken") return null;
  const mode = status.mode;
  const needsCurrent = mode === "password";

  const close = () => {
    setPending(null);
    setCurrent("");
    setNext("");
    setAgain("");
  };

  const send = async (change: LockChange, proof: string | null) => {
    if (busy.current) return;
    busy.current = true;
    setError("");
    try {
      const r = await api.lockChange(change, proof, tx("Notevine 잠금 설정 변경"));
      if (r.status === "ok") close();
      if (r.status === "wrong") setError(tx("비밀번호가 맞지 않습니다."));
      if (r.status === "wait") setError(tx("너무 많이 틀렸습니다. {0}초 뒤에 다시 입력하세요.", r.seconds));
      if (r.status === "unavailable") setError(tx("Windows 설정에서 Windows Hello(PIN·지문·얼굴)를 먼저 설정하세요."));
      if (r.status === "failed") setError(tx("본인 확인에 실패했습니다"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  /** Asks for the passwords a change needs, or makes it at once. */
  const ask = (change: LockChange, newPassword = false) => {
    setError("");
    close();
    if (needsCurrent || newPassword) setPending({ change, newPassword });
    else void send(change, null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pending) return;
    if (pending.newPassword) {
      if ([...next].length < MIN_CHARS) return setError(tx("4자 이상으로 정하세요."));
      if (next !== again) return setError(tx("두 번 입력한 비밀번호가 같지 않습니다."));
    }
    const change = pending.newPassword ? { ...pending.change, password: next } : pending.change;
    void send(change, needsCurrent ? current : null);
  };

  const field = (label: string, value: string, set: (v: string) => void, first = false) => (
    <input
      type="password"
      aria-label={label}
      placeholder={label}
      value={value}
      autoFocus={first}
      onChange={(e) => set(e.target.value)}
    />
  );

  return (
    <>
      <Row label={tx("앱 잠금")} hint={tx("자리를 비웠을 때 화면을 가립니다. 노트 파일은 암호화하지 않습니다")}>
        <select
          value={pending?.change.mode ?? mode}
          onChange={(e) => {
            const to = e.target.value as LockMode;
            if (to === mode) return close();
            ask({ mode: to }, to === "password");
          }}
        >
          <option value="off">{tx("없음")}</option>
          <option value="hello">Windows Hello</option>
          <option value="password">{tx("비밀번호")}</option>
        </select>
      </Row>
      {mode !== "off" && (
        <Row label={tx("자동 잠금")} hint={tx("입력이 없으면")}>
          <select
            value={pending?.change.idle_minutes ?? status.idle_minutes}
            onChange={(e) => ask({ idle_minutes: Number(e.target.value) })}
          >
            {IDLE_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m ? tx("{0}분", m) : tx("사용 안 함")}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={() => void api.lockNow()}>
            {tx("지금 잠그기")}
          </button>
          {mode === "password" && (
            <button className="btn small" onClick={() => ask({ mode: "password" }, true)}>
              {tx("비밀번호 바꾸기")}
            </button>
          )}
        </Row>
      )}
      {pending && (
        <form className="lock-form" onSubmit={submit}>
          {needsCurrent && field(tx("현재 비밀번호"), current, setCurrent, true)}
          {pending.newPassword && field(tx("새 비밀번호"), next, setNext, !needsCurrent)}
          {pending.newPassword && field(tx("비밀번호 확인"), again, setAgain)}
          <button className="btn small primary">{tx("확인")}</button>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              setError("");
              close();
            }}
          >
            {tx("취소")}
          </button>
        </form>
      )}
      {error && <p className="lock-error small">{error}</p>}
    </>
  );
}
