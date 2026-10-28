import type { NoteRef } from "../api";

const norm = (s: string) => s.normalize("NFC").toLowerCase();

/** True when every char of `q` appears in `s` in order ("회록" ⊂ "회의록"). */
function subsequence(s: string, q: string): boolean {
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length;
}

/**
 * Orders notes for quick open (FR-SRC-01): without a query, recently opened
 * first; with one, title prefix > title substring > path substring > subsequence.
 */
export function rankNotes(notes: NoteRef[], query: string, recent: string[]): NoteRef[] {
  const q = norm(query.trim());
  const recentRank = new Map(recent.map((p, i) => [p, i]));
  const scored: { n: NoteRef; score: number }[] = [];
  for (const n of notes) {
    const t = norm(n.title);
    const p = norm(n.path);
    let score: number;
    if (!q) score = 0;
    else if (t.startsWith(q)) score = 0;
    else if (t.includes(q)) score = 1;
    else if (p.includes(q)) score = 2;
    else if (subsequence(t, [...q].filter((c) => c !== " ").join(""))) score = 3;
    else continue;
    scored.push({ n, score });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        (recentRank.get(a.n.path) ?? 1e9) - (recentRank.get(b.n.path) ?? 1e9) ||
        a.n.title.length - b.n.title.length ||
        a.n.title.localeCompare(b.n.title, "ko"),
    )
    .map((x) => x.n);
}
