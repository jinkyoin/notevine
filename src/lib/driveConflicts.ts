import type { DriveConflict } from "../api";

/** The copies not reported yet. `seen` is left holding exactly what was found, so a copy
 *  that goes away and comes back counts as new. */
export function unseenConflicts(found: DriveConflict[], seen: Set<string>): DriveConflict[] {
  const fresh = found.filter((c) => !seen.has(c.copy));
  seen.clear();
  for (const c of found) seen.add(c.copy);
  return fresh;
}
