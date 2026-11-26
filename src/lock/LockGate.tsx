// SCR-30 잠금 화면 (NFR-SEC-04): 잠겨 있으면 앱 화면 위를 가리고 Windows Hello나 비밀번호를 받는다.
// 아래 화면(열린 노트·대화상자)은 그대로 두어, 풀면 하던 곳으로 돌아온다. 노트에서 온 글자는 보이지 않는다.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "../../src-tauri/app-icon.svg?url";
import { api, type LockStatus } from "../api";
import { tx } from "../i18n";
import { shouldAutoPrompt, startLockSync, useLock } from "./lockStore";

/** The window is in front: visible and focused. */
function useWindowShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let live = true;
    const set = (focused: boolean) => live && setShown(focused && document.visibilityState === "visible");
    const look = () => void win.isFocused().then(set).catch(() => {});
    look();
    const off = win.onFocusChanged(({ payload }) => set(payload));
    document.addEventListener("visibilitychange", look);
    return () => {
      live = false;
      void off.then((f) => f()).catch(() => {});
      document.removeEventListener("visibilitychange", look);
    };
  }, []);
  return shown;
}

/**
 * Tells the app the lock screen has been drawn, so it can take its own cover off the window.
 * Sent again whenever the window comes forward: the app ignores it while the window can't be seen.
 */
function usePaintedNotice(status: LockStatus | null, shown: boolean) {
  useEffect(() => {
    if (!status?.locked || status.away) return;
    let sent = false;
    const send = () => {
      if (sent || document.visibilityState !== "visible") return;
      sent = true;
      void api.lockPainted().catch(() => {});
    };
    // Two frames: the first is only asked for, the second comes after it was drawn.
    let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(send)));
    const late = window.setTimeout(send, 500);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(late);
    };
  }, [status, shown]);
}

const waitText = (seconds: number) => tx("너무 많이 틀렸습니다. {0}초 뒤에 다시 입력하세요.", seconds);

function PasswordForm({ shown }: { shown: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (shown) input.current?.focus();
  }, [shown]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy.current) return;
    busy.current = true;
    try {
      // Right: the app says it is open, and this screen goes.
      const r = await api.lockUnlockPassword(password);
      setPassword("");
      setError(r === 0 ? "" : r > 0 ? waitText(r) : tx("비밀번호가 맞지 않습니다."));
    } catch {
      setError(tx("잠금 상태를 확인하지 못했습니다"));
    } finally {
      busy.current = false;
      input.current?.focus();
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <input
        ref={input}
        type="password"
        autoFocus
        aria-label={tx("비밀번호")}
        placeholder={tx("비밀번호")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn primary">{tx("열기")}</button>
      {error && <p className="lock-error">{error}</p>}
      <p className="muted small">{tx("비밀번호를 잊었으면 사용자 매뉴얼을 보세요")}</p>
    </form>
  );
}

function HelloUnlock({ status, shown }: { status: LockStatus; shown: boolean }) {
  const [error, setError] = useState("");
  const busy = useRef(false);
  const prompted = useRef<number | null>(null);
  const button = useRef<HTMLButtonElement>(null);

  const ask = async () => {
    if (busy.current) return;
    busy.current = true;
    setError("");
    try {
      const outcome = await api.lockUnlockHello(tx("Notevine 잠금 해제"));
      if (outcome === "unavailable") setError(tx("Windows Hello를 다시 설정하세요"));
      if (outcome === "failed") setError(tx("본인 확인에 실패했습니다"));
    } catch {
      setError(tx("본인 확인에 실패했습니다"));
    } finally {
      busy.current = false;
      button.current?.focus();
    }
  };

  useEffect(() => {
    if (shown) button.current?.focus();
    if (!shouldAutoPrompt(status, shown, prompted.current)) return;
    prompted.current = status.epoch;
    void ask();
  }, [status, shown]);

  return (
    <>
      <button ref={button} className="btn primary" autoFocus onClick={() => void ask()}>
        {tx("잠금 해제")}
      </button>
      {error && <p className="lock-error">{error}</p>}
    </>
  );
}

function LockScreen({ status, shown }: { status: LockStatus | null; shown: boolean }) {
  const failed = useLock((s) => s.failed);
  const quitHeld = useLock((s) => s.quitHeld);
  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label={tx("앱 잠금")}>
      <img src={logo} alt="" width={56} height={56} />
      <h1>Notevine</h1>
      {failed && <p className="lock-error">{tx("잠금 상태를 확인하지 못했습니다")}</p>}
      {status?.mode === "password" && <PasswordForm shown={shown} />}
      {status?.mode === "hello" && <HelloUnlock status={status} shown={shown} />}
      {status?.mode === "broken" && <p className="lock-error">{tx("잠금 설정을 읽지 못했습니다. 사용자 매뉴얼을 보세요")}</p>}
      {quitHeld && <p className="lock-error">{tx("저장하지 못한 편집이 있어 종료하지 않았습니다. 잠금을 풀어 확인하세요")}</p>}
    </div>
  );
}

export default function LockGate({ children }: { children: ReactNode }) {
  const status = useLock((s) => s.status);
  const shown = useWindowShown();
  useEffect(() => startLockSync(), []);
  usePaintedNotice(status, shown);
  return (
    <>
      {/* Nothing is drawn before we know whether it may be seen. */}
      {status && children}
      {(!status || status.locked) && createPortal(<LockScreen status={status} shown={shown} />, document.body)}
    </>
  );
}
