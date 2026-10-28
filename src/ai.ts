// AI 도우미 (FR-AI-01~06): 설치·로그인된 Claude Code / Codex CLI로 질의한다.
// 노트 내용은 사용자가 전송 확인(SCR-19)을 거친 것만 보낸다 (FR-AI-03, NFR-SEC-02).
import { api, type AiEvent, type AiProvider, type ContextNote } from "./api";

const KEY_ENABLED = "notevine.ai.enabled";
const KEY_PROVIDER = "notevine.ai.provider";

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc.: setting just isn't remembered */
  }
}

/** AI is off until the user turns it on (it is the one feature that sends data out). */
export const aiPrefs = {
  enabled: () => load(KEY_ENABLED) === "1",
  setEnabled: (on: boolean) => save(KEY_ENABLED, on ? "1" : "0"),
  provider: () => load(KEY_PROVIDER) ?? "",
  setProvider: (id: string) => save(KEY_PROVIDER, id),
  /** Model name passed to the CLI (empty = the CLI's default). */
  model: (provider: string) => load(`notevine.ai.model.${provider}`) ?? "",
  setModel: (provider: string, model: string) => save(`notevine.ai.model.${provider}`, model.trim()),
};

export function pickProvider(list: AiProvider[], preferred: string): AiProvider | undefined {
  const ok = list.filter((p) => p.available && p.logged_in !== false);
  return ok.find((p) => p.id === preferred) ?? ok[0];
}

export const PROVIDER_COMPANY: Record<string, string> = { claude: "Anthropic", codex: "OpenAI" };

/**
 * Models offered in the picker. "" = the CLI's own default. Aliases like "opus"
 * follow the newest model of that family; the user can also type any name.
 * (Claude names checked against Claude Code 2.1.312 on 2026-10-28.)
 */
export const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: "", label: "기본 (Opus)" },
    { value: "opus", label: "Opus · 가장 똑똑함" },
    { value: "sonnet", label: "Sonnet · 균형" },
    { value: "haiku", label: "Haiku · 가장 빠름" },
    { value: "claude-fable-5-1", label: "Fable 5.1" },
  ],
  codex: [
    { value: "", label: "기본" },
    { value: "gpt-6.1-sol", label: "gpt-6.1-sol" },
  ],
};

// ---------- prompts ----------

export const QA_SYSTEM = [
  "너는 사용자의 개인 업무 노트를 바탕으로 답하는 한국어 도우미다.",
  "<참고 노트>에 있는 내용만 근거로 답한다. 노트에 없는 내용은 추측하지 말고 노트에서 찾지 못했다고 말한다.",
  "근거로 쓴 노트는 해당 문장 끝에 [[노트 제목]] 형식으로 표시한다. 제목은 note 태그의 title 값을 그대로 쓴다.",
  "답은 간결한 마크다운으로 쓴다. 인사말이나 불필요한 서론은 쓰지 않는다.",
].join("\n");

export type WriteTask = "summarize" | "polish" | "continue" | "translate";

export const WRITE_LABEL: Record<WriteTask, string> = {
  summarize: "요약",
  polish: "다듬기",
  continue: "이어 쓰기",
  translate: "영어로 번역",
};

const WRITE_INSTRUCTION: Record<WriteTask, string> = {
  summarize: "다음 글을 핵심만 남겨 3~5개 항목의 마크다운 목록으로 요약해라.",
  polish: "다음 글의 뜻은 그대로 두고 맞춤법, 띄어쓰기, 어색한 문장을 자연스러운 업무 문체로 다듬어라. 마크다운 서식은 유지한다.",
  continue: "다음 글의 흐름과 문체를 이어서 한두 문단을 더 써라. 원문은 반복하지 말고 이어질 내용만 쓴다.",
  translate: "다음 글을 자연스러운 영어로 번역해라. 마크다운 서식은 유지한다.",
};

export const WRITE_SYSTEM =
  "너는 한국어 글쓰기 도우미다. 요청한 결과 글만 출력한다. 설명, 인사, 따옴표, 코드 블록 감싸기 없이 결과만 쓴다.";

export function writePrompt(task: WriteTask, noteTitle: string, text: string): string {
  return `${WRITE_INSTRUCTION[task]}\n\n노트 제목: ${noteTitle}\n\n<글>\n${text}\n</글>`;
}

export const REVIEW_SYSTEM =
  "너는 업무 기록을 정리하는 한국어 도우미다. 제공된 업무일지만 근거로, 지어내지 말고 정리한다. 결과 마크다운만 출력한다.";

export function reviewPrompt(weekLabel: string): string {
  return [
    `<참고 노트>의 업무일지(${weekLabel})를 바탕으로 주간 회고 초안을 써라.`,
    "다음 구성의 마크다운으로 쓰고, 각 항목 끝에 근거 업무일지를 [[노트 제목]]으로 단다.",
    "## 이번 주 한 일\n## 잘된 점\n## 아쉬운 점·막힌 일\n## 다음 주 할 일",
    "업무일지에 없는 내용은 쓰지 않는다. 내용이 없는 항목은 '- (기록 없음)'으로 둔다.",
  ].join("\n");
}

/** Monday–Sunday of the week containing `d`, as YYYY-MM-DD strings, plus an ISO-like label. */
export function weekRange(d = new Date()): { from: string; to: string; label: string } {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  const f = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  // ISO week number
  const t = new Date(Date.UTC(mon.getFullYear(), mon.getMonth(), mon.getDate() + 3));
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return { from: f(mon), to: f(sun), label: `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}` };
}

/** Journal notes ("…/YYYY-MM-DD.md" under the journal folder) dated within [from, to]. */
export function journalNotesInRange(paths: string[], journalFolder: string, from: string, to: string): string[] {
  return paths
    .filter((p) => p.startsWith(journalFolder + "/"))
    .filter((p) => {
      const m = /(\d{4}-\d{2}-\d{2})[^/]*\.md$/i.exec(p);
      return !!m && m[1] >= from && m[1] <= to;
    })
    .sort();
}

/** Turns a chat transcript into the prompt for a follow-up question. */
export function chatPrompt(history: { role: "user" | "ai"; text: string }[], question: string): string {
  const recent = history.slice(-6);
  const past = recent.length
    ? "<이전 대화>\n" + recent.map((m) => `${m.role === "user" ? "사용자" : "AI"}: ${m.text}`).join("\n\n") + "\n</이전 대화>\n\n"
    : "";
  return `${past}질문: ${question}`;
}

// ---------- running ----------

let seq = 0;

export interface RunHandle {
  id: string;
  done: Promise<{ text: string; cost: number | null }>;
  cancel: () => void;
}

/** Starts a run and reports streamed text through `onText` (full text so far). */
export function runAi(
  provider: string,
  system: string,
  prompt: string,
  notes: string[],
  onText: (text: string) => void,
  onNotice?: (m: string) => void,
  onModel?: (model: string) => void,
): RunHandle {
  const id = `ai-${Date.now()}-${++seq}`;
  let acc = "";
  const done = new Promise<{ text: string; cost: number | null }>((resolve, reject) => {
    const onEvent = (e: AiEvent) => {
      if (e.kind === "started") {
        if (e.model) onModel?.(e.model);
      } else if (e.kind === "delta") {
        acc += e.text;
        onText(acc);
      } else if (e.kind === "notice") onNotice?.(e.message);
      else if (e.kind === "done") {
        onText(e.text);
        resolve({ text: e.text, cost: e.cost_usd });
      } else if (e.kind === "error") reject(new Error(e.message));
    };
    api.aiRun(id, provider, system, prompt, notes, aiPrefs.model(provider) || null, onEvent).catch((err) => reject(err instanceof Error ? err : new Error(String((err as { message?: string })?.message ?? err))));
  });
  return { id, done, cancel: () => void api.aiCancel(id).catch(() => {}) };
}

export function totalChars(notes: ContextNote[]): number {
  return notes.reduce((n, x) => n + x.chars, 0);
}
