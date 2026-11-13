import { describe, expect, it } from "vitest";
import { autoBackupDue } from "./autoBackup";

const HOUR = 60;
const MIN = 60_000;
const NOW = 1_000_000_000_000;
const base = { repo: true, trusted: true, problem: null, changed: 3, ahead: 0, last_at: NOW - 61 * MIN };

describe("timed Git backup", () => {
  it("is due when something changed and an hour has passed since the last backup", () => {
    expect(autoBackupDue(base, NOW, HOUR)).toBe(true);
  });

  it("counts from the last backup, not from when the folder was opened", () => {
    expect(autoBackupDue({ ...base, last_at: NOW - 59 * MIN }, NOW, HOUR)).toBe(false);
    expect(autoBackupDue({ ...base, last_at: NOW - 60 * MIN }, NOW, HOUR)).toBe(true);
  });

  it("is due at once for a folder that was never backed up", () => {
    expect(autoBackupDue({ ...base, last_at: null }, NOW, HOUR)).toBe(true);
  });

  it("does nothing when there is nothing to save", () => {
    expect(autoBackupDue({ ...base, changed: 0, ahead: 0 }, NOW, HOUR)).toBe(false);
  });

  it("sends backups that were made but not sent", () => {
    expect(autoBackupDue({ ...base, changed: 0, ahead: 2 }, NOW, HOUR)).toBe(true);
  });

  it("stays off when the interval is off, it is no repository, not allowed here, or has a problem", () => {
    expect(autoBackupDue(base, NOW, 0)).toBe(false);
    expect(autoBackupDue({ ...base, repo: false }, NOW, HOUR)).toBe(false);
    expect(autoBackupDue({ ...base, trusted: false }, NOW, HOUR)).toBe(false);
    expect(autoBackupDue({ ...base, problem: "열쇠가 없습니다" }, NOW, HOUR)).toBe(false);
  });

  it("does not try again at every check when a backup keeps failing", () => {
    expect(autoBackupDue(base, NOW, HOUR, NOW - 5 * MIN)).toBe(false);
    expect(autoBackupDue(base, NOW, HOUR, NOW - 60 * MIN)).toBe(true);
  });
});
