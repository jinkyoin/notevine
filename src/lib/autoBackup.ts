// 자동 백업(설정 → 백업)이 지금 해야 할 때인지 판단한다.
// 간격은 "마지막 백업 시각"에서 잰다. 창에서 폴더를 바꾸거나 앱을 다시 켜도 밀리거나 처음부터 다시 세지 않는다.
import type { BackupStatus } from "../api";

/** How often the state is looked at. A backup itself waits for `minutes` since the last one. */
export const CHECK_MINUTES = 5;

type Seen = Pick<BackupStatus, "repo" | "trusted" | "problem" | "changed" | "ahead" | "last_at">;

/**
 * Due when something is left to save and `minutes` have passed since the last backup
 * (the time of its commit; never backed up counts as long ago). `lastTried` is the time of the
 * last timed attempt in this run: a backup that keeps failing is tried again after `minutes`,
 * not at every check.
 */
export function autoBackupDue(s: Seen, now: number, minutes: number, lastTried: number | null = null): boolean {
  if (!minutes || !s.repo || !s.trusted || s.problem) return false;
  if (s.changed <= 0 && s.ahead <= 0) return false;
  const span = minutes * 60_000;
  if (s.last_at !== null && now - s.last_at < span) return false;
  return lastTried === null || now - lastTried >= span;
}
