// Properties whose value is picked from a list in the properties panel: `type` and `status`.
import { tx } from "../i18n";

export type ChoiceKey = "type" | "status";

/** The note kinds the PARA templates use. */
export const TYPE_CHOICES: { value: string; label: () => string }[] = [
  { value: "idea", label: () => tx("아이디어") },
  { value: "research", label: () => tx("자료") },
  { value: "project", label: () => tx("프로젝트") },
  { value: "journal", label: () => tx("업무일지") },
  { value: "meeting", label: () => tx("회의록") },
  { value: "guide", label: () => tx("안내") },
];

export function choiceKey(key: string): ChoiceKey | null {
  const k = key.trim().toLowerCase();
  return k === "type" || k === "status" ? k : null;
}

export interface ChoiceOption {
  value: string;
  label: string;
}

/**
 * The list for a `type` or `status` value: the known values first (note kinds, or the
 * note folder's statuses), then other values used in the vault, then the current value.
 */
export function choiceOptions(key: ChoiceKey, current: string, vaultValues: string[], statuses: string[]): ChoiceOption[] {
  const known: ChoiceOption[] =
    key === "type"
      ? TYPE_CHOICES.map((c) => ({ value: c.value, label: `${c.value} · ${c.label()}` }))
      : statuses.map((s) => ({ value: s, label: s }));
  const seen = new Set(known.map((o) => o.value));
  const out = [...known];
  for (const raw of [...vaultValues, current]) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, label: v });
  }
  return out;
}
