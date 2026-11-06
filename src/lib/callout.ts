// 강조 상자: "> [!중요] 제목" 으로 시작하는 인용문을 내용의 중요도나 성격을 보여 주는 색 상자로 그린다.
// 옵시디언·GitHub의 [!important] 같은 영어 이름도 같은 상자로 보인다.

export type CalloutKind = "important" | "warning" | "note" | "tip" | "decision" | "question" | "idea";

export interface CalloutType {
  kind: CalloutKind;
  /** The name written in the note: `[!중요]`. */
  label: string;
  icon: string;
}

/** As the format bar lists them: by importance, then by what the content is. */
export const CALLOUTS: CalloutType[] = [
  { kind: "important", label: "중요", icon: "!" },
  { kind: "warning", label: "주의", icon: "⚠" },
  { kind: "note", label: "참고", icon: "i" },
  { kind: "tip", label: "팁", icon: "✓" },
  { kind: "decision", label: "결정", icon: "★" },
  { kind: "question", label: "질문", icon: "?" },
  { kind: "idea", label: "아이디어", icon: "✦" },
];

const ALIASES: Record<string, CalloutKind> = {
  중요: "important",
  important: "important",
  주의: "warning",
  경고: "warning",
  warning: "warning",
  caution: "warning",
  danger: "warning",
  attention: "warning",
  error: "warning",
  참고: "note",
  note: "note",
  info: "note",
  abstract: "note",
  summary: "note",
  quote: "note",
  팁: "tip",
  tip: "tip",
  hint: "tip",
  success: "tip",
  check: "tip",
  done: "tip",
  결정: "decision",
  decision: "decision",
  질문: "question",
  question: "question",
  faq: "question",
  help: "question",
  아이디어: "idea",
  idea: "idea",
};

/** The first line of a quote, after "> ": `[!중요] 제목` (`[!note]-` folds in Obsidian; here it just shows). */
export const CALLOUT_HEAD = /^(\[!([^\]\s]+)\][+-]?)(?:[ \t]+(.*))?$/;

export interface CalloutHead {
  type: CalloutType;
  /** Title after the marker, or "" (the label is then shown). */
  title: string;
  /** Length of the `[!…]` marker (with a +/-). */
  markLen: number;
}

/** Reads the callout marker at the start of a quote's first line; null if it isn't one. */
export function calloutHead(firstLine: string): CalloutHead | null {
  const m = CALLOUT_HEAD.exec(firstLine.trimEnd());
  if (!m) return null;
  const kind = ALIASES[m[2].toLowerCase()] ?? "note";
  return { type: CALLOUTS.find((c) => c.kind === kind)!, title: (m[3] ?? "").trim(), markLen: m[1].length };
}

/** The marker written for a type: `[!중요]`. */
export const calloutMark = (t: CalloutType) => `[!${t.label}]`;
