import type { BackupStatus } from "../api";

/** 백업이 끝나거나 설정에서 허용·원격·열쇠가 바뀌면 알린다(상단바 백업 단추가 상태를 바로 다시 읽게). */
export const BACKUP_CHANGED_EVENT = "notevine:backup-changed";

/** What the top bar's 백업 button shows: whether it appears, and its dot. */
export interface BackupBadge {
  show: boolean;
  /** `pending`: changes not backed up yet. `warn`: something stops the backup or leaves it local. */
  dot: "none" | "pending" | "warn";
}

export function backupBadge(s: BackupStatus | null): BackupBadge {
  // Only for a vault that is a Git repository allowed on this PC.
  if (!s || !s.git || !s.repo || !s.trusted) return { show: false, dot: "none" };
  // An encrypted vault with no remote is saved on this PC only: the user should see it.
  if (s.problem || (s.encrypted && !s.remote)) return { show: true, dot: "warn" };
  if (s.changed > 0 || s.ahead > 0) return { show: true, dot: "pending" };
  return { show: true, dot: "none" };
}
