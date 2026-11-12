import { describe, expect, it } from "vitest";
import type { BackupStatus } from "../api";
import { backupBadge } from "./backupBadge";

const base: BackupStatus = {
  git: true,
  repo: true,
  trusted: true,
  branch: "main",
  remote: "https://example.com/n.git",
  changed: 0,
  ahead: 0,
  behind: 0,
  last_at: null,
  last_message: null,
  encrypted: false,
  key_ok: false,
  problem: null,
};

describe("backupBadge", () => {
  it("shows nothing until the status is known, or for a folder that is not a Git repository", () => {
    expect(backupBadge(null).show).toBe(false);
    expect(backupBadge({ ...base, git: false }).show).toBe(false);
    expect(backupBadge({ ...base, repo: false }).show).toBe(false);
  });

  it("shows nothing for a repository the user has not allowed on this PC", () => {
    expect(backupBadge({ ...base, trusted: false }).show).toBe(false);
  });

  it("has no dot when everything is backed up", () => {
    expect(backupBadge(base)).toEqual({ show: true, dot: "none" });
  });

  it("marks changed notes or commits not yet sent", () => {
    expect(backupBadge({ ...base, changed: 2 }).dot).toBe("pending");
    expect(backupBadge({ ...base, ahead: 1 }).dot).toBe("pending");
  });

  it("warns about a problem, and about an encrypted vault with no remote", () => {
    expect(backupBadge({ ...base, problem: "열쇠 없음" }).dot).toBe("warn");
    expect(backupBadge({ ...base, encrypted: true, key_ok: true, remote: null }).dot).toBe("warn");
    // A plain vault without a remote is a local-only backup on purpose.
    expect(backupBadge({ ...base, remote: null }).dot).toBe("none");
    expect(backupBadge({ ...base, remote: null, changed: 1 }).dot).toBe("pending");
  });
});
