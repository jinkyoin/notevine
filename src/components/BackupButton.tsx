// 상단바의 백업 단추: Git 저장소로 허용된 노트 폴더에서만 보이고, 글자 "백업"과 상태 점만 둔다.
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type BackupStatus } from "../api";
import { useApp } from "../store";
import { BACKUP_CHANGED_EVENT, backupBadge } from "../lib/backupBadge";
import { dateLocale, tx } from "../i18n";

const REFRESH_MS = 30_000;

function hint(s: BackupStatus): string {
  const parts: string[] = [];
  if (s.problem) parts.push(s.problem);
  else if (s.encrypted && !s.remote) parts.push(tx("원격 저장소 주소가 없어 이 PC에만 저장됩니다"));
  if (s.changed > 0) parts.push(tx("바뀐 노트 {0}개", s.changed));
  if (s.ahead > 0) parts.push(tx("보낼 백업 {0}개", s.ahead));
  parts.push(
    s.last_at ? tx("마지막 백업 {0}", new Date(s.last_at).toLocaleString(dateLocale())) : tx("아직 백업한 적 없음"),
  );
  return parts.join(" · ");
}

export function BackupButton({ root }: { root: string }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);

  // 상태를 읽지 못하면 단추를 숨기지 않고 이유를 보여 준다(숨기면 왜 안 보이는지 알 수 없다).
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void api
      .backupStatus()
      .then((s) => {
        setStatus(s);
        setFailed(null);
      })
      .catch((e) => {
        setStatus(null);
        setFailed(errorMessage(e));
      });
  }, []);

  // 폴더가 바뀌면 다시 읽고, 그 뒤에는 창이 보일 때 주기적으로 읽는다. 상태 조회는 이 PC의 Git만 본다.
  useEffect(() => {
    setStatus(null);
    refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    window.addEventListener(BACKUP_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(BACKUP_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [root, refresh]);

  if (failed && !status) {
    return (
      <button className="btn ghost small backup-btn" onClick={refresh} title={failed}>
        {tx("백업")}
        <span className="backup-dot warn" role="img" aria-label={tx("확인이 필요함")} />
      </button>
    );
  }
  const badge = backupBadge(status);
  if (!badge.show || !status) return null;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await useApp.getState().backupNow();
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <button className="btn ghost small backup-btn" disabled={busy} onClick={() => void run()} title={hint(status)}>
      {busy ? tx("백업 중…") : tx("백업")}
      {!busy && badge.dot !== "none" && (
        <span
          className={`backup-dot ${badge.dot}`}
          role="img"
          aria-label={badge.dot === "warn" ? tx("확인이 필요함") : tx("백업하지 않은 변경이 있음")}
        />
      )}
    </button>
  );
}
