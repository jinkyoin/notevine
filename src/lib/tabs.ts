// 탭 (FR-EDT-07): 열린 노트 목록과 탭마다의 이전/다음 기록. 화면과 상관없는 규칙만 둔다.
// 같은 노트는 탭 하나에만 열린다. 이미 열린 노트를 다시 열면 그 탭으로 옮겨 간다.

export interface Tab {
  path: string;
  /** Notes this tab showed before (Alt+←), oldest first. */
  back: string[];
  /** Notes to go forward to (Alt+→), next first. */
  forward: string[];
}

export interface Tabs {
  tabs: Tab[];
  /** Path of the tab on screen, or null when no note is open. */
  active: string | null;
}

const HISTORY_LIMIT = 50;

/**
 * Opens `path`: switches to its tab when it is open, else opens it in a new tab
 * right of the current one (`newTab`, or no tab yet) or in the current tab.
 */
export function openTab(s: Tabs, path: string, newTab: boolean): Tabs {
  if (s.tabs.some((t) => t.path === path)) return { ...s, active: path };
  const i = s.tabs.findIndex((t) => t.path === s.active);
  if (newTab || i < 0) {
    const tabs = [...s.tabs];
    tabs.splice(i + 1, 0, { path, back: [], forward: [] });
    return { tabs, active: path };
  }
  const cur = s.tabs[i];
  const tabs = [...s.tabs];
  tabs[i] = { path, back: [...cur.back, cur.path].slice(-HISTORY_LIMIT), forward: [] };
  return { tabs, active: path };
}

/** Closes the tab of `path`; the one to its right (else left) takes its place on screen. */
export function closeTab(s: Tabs, path: string): Tabs {
  const i = s.tabs.findIndex((t) => t.path === path);
  if (i < 0) return s;
  const tabs = s.tabs.filter((_, j) => j !== i);
  if (s.active !== path) return { tabs, active: s.active };
  return { tabs, active: (tabs[i] ?? tabs[i - 1])?.path ?? null };
}

/** Keeps only the tab of `path`. */
export function closeOtherTabs(s: Tabs, path: string): Tabs {
  const tab = s.tabs.find((t) => t.path === path);
  return tab ? { tabs: [tab], active: path } : s;
}

/** The next (1) or previous (-1) tab, wrapping around. */
export function stepTab(s: Tabs, dir: 1 | -1): Tabs {
  const n = s.tabs.length;
  if (n < 2) return s;
  const i = s.tabs.findIndex((t) => t.path === s.active);
  return { ...s, active: s.tabs[(i + dir + n) % n].path };
}

/**
 * Alt+← / Alt+→ within the current tab, skipping notes that no longer exist.
 * A note open in another tab is shown there instead. Null when there is nowhere to go.
 */
export function goHistory(s: Tabs, dir: -1 | 1, exists: (path: string) => boolean): Tabs | null {
  const i = s.tabs.findIndex((t) => t.path === s.active);
  if (i < 0) return null;
  const cur = s.tabs[i];
  const list = dir < 0 ? [...cur.back].reverse() : cur.forward;
  const k = list.findIndex(exists);
  if (k < 0) return null;
  const target = list[k];
  const tabs = [...s.tabs];
  if (s.tabs.some((t) => t.path === target)) {
    // Already open elsewhere: go there and forget it here, so a note stays in one tab.
    tabs[i] = { ...cur, back: cur.back.filter((p) => p !== target), forward: cur.forward.filter((p) => p !== target) };
    return { tabs, active: target };
  }
  if (dir < 0) {
    const at = cur.back.lastIndexOf(target);
    tabs[i] = { path: target, back: cur.back.slice(0, at), forward: [cur.path, ...cur.forward] };
  } else {
    tabs[i] = { path: target, back: [...cur.back, cur.path], forward: cur.forward.slice(k + 1) };
  }
  return { tabs, active: target };
}

/** Rewrites paths after a rename or move: `map` returns the new path (or the same one). */
export function remapTabs(s: Tabs, map: (path: string) => string): Tabs {
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const t of s.tabs) {
    const path = map(t.path);
    if (seen.has(path)) continue;
    seen.add(path);
    tabs.push({ path, back: t.back.map(map), forward: t.forward.map(map) });
  }
  return { tabs, active: s.active === null ? null : map(s.active) };
}

/** Drops tabs (and history entries) whose note is gone; the active tab moves like closeTab. */
export function dropTabs(s: Tabs, keep: (path: string) => boolean): Tabs {
  let next = s;
  for (const t of s.tabs) if (!keep(t.path)) next = closeTab(next, t.path);
  return {
    tabs: next.tabs.map((t) => ({ ...t, back: t.back.filter(keep), forward: t.forward.filter(keep) })),
    active: next.active,
  };
}
