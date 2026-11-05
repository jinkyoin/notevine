// AI 도우미 (FR-AI-01~06): 설치·로그인된 Claude Code / Codex CLI로 질의한다.
// 노트 내용은 사용자가 전송 확인(SCR-19)을 거친 것만 보낸다 (FR-AI-03, NFR-SEC-02).
import { api, type AiEvent, type AiProvider, type ContextNote } from "./api";

import { tx } from "./i18n";
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
  /** Let the AI also search the web when answering (asked in the send dialog). */
  web: () => load("notevine.ai.web") !== "0",
  setWeb: (on: boolean) => save("notevine.ai.web", on ? "1" : "0"),
  /** Model name passed to the CLI (empty = the CLI's default). */
  model: (provider: string) => load(`notevine.ai.model.${provider}`) ?? "",
  setModel: (provider: string, model: string) => save(`notevine.ai.model.${provider}`, model.trim()),
};

export function pickProvider(list: AiProvider[], preferred: string): AiProvider | undefined {
  const ok = list.filter((p) => p.available && p.logged_in !== false);
  return ok.find((p) => p.id === preferred) ?? ok[0];
}

export const PROVIDER_COMPANY: Record<string, string> = {
  claude: "Anthropic",
  codex: "OpenAI",
  anthropic: "Anthropic",
  openai: "OpenAI",
  ollama: tx("내 PC의 Ollama"),
};

/** Connected with an API key or Ollama (FR-AI-07): their models come from the service. */
export const API_PROVIDERS = ["anthropic", "openai", "ollama"];

/** What "기본" means for an API provider. */
export const API_DEFAULT_LABEL: Record<string, string> = {
  anthropic: tx("기본 (claude-opus-5-5)"),
  openai: tx("기본 (가장 최근 모델)"),
  ollama: tx("기본 (설치된 첫 모델)"),
};

/** Official install commands (PowerShell), shown when a CLI is missing. */
export const INSTALL_COMMAND: Record<string, string> = {
  claude: "irm https://claude.ai/install.ps1 | iex",
  codex: "npm install -g @openai/codex",
};

/** Installed but logged out: the one case a login button can fix. */
export const needsLogin = (p: AiProvider) => p.version !== null && p.logged_in === false;

/** Error text the backend gives for a missing or expired login. */
/** A provider's name and state as the backend reports them, in the screen language. */
export function localizeProvider(p: AiProvider): AiProvider {
  const name = p.id === "ollama" ? tx("Ollama (내 PC)") : p.name;
  const d = p.detail ?? "";
  let m: RegExpExecArray | null;
  const detail = !d
    ? p.detail
    : d === "Claude Code가 설치되어 있지 않습니다"
      ? tx("Claude Code가 설치되어 있지 않습니다")
      : d === "Codex CLI가 설치되어 있지 않습니다"
        ? tx("Codex CLI가 설치되어 있지 않습니다")
        : d === "로그인이 필요합니다"
          ? tx("로그인이 필요합니다")
          : d === "API 키를 넣으면 쓸 수 있습니다"
            ? tx("API 키를 넣으면 쓸 수 있습니다")
            : (m = /^Ollama가 실행 중이 아닙니다 \((.*)\)$/.exec(d))
              ? tx("Ollama가 실행 중이 아닙니다 ({0})", m[1])
              : (m = /^(.*)을\(를\) 실행할 수 없습니다 \((.*) --version 실패\)$/.exec(d))
                ? tx("{0}을(를) 실행할 수 없습니다 ({1} --version 실패)", m[1], m[2])
                : d;
  return { ...p, name, detail };
}

export const isLoginError = (message: string) => message.includes("로그인되어 있지 않습니다");

/**
 * Models offered in the picker. "" = the CLI's own default. Aliases like "opus"
 * follow the newest model of that family; the user can also type any name.
 * (Claude names checked against Claude Code 2.1.312 on 2026-10-28.)
 */
export const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: "", label: tx("기본 (Opus)") },
    { value: "opus", label: tx("Opus · 가장 똑똑함") },
    { value: "sonnet", label: tx("Sonnet · 균형") },
    { value: "haiku", label: tx("Haiku · 가장 빠름") },
    { value: "claude-fable-5-1", label: "Fable 5.1" },
  ],
  codex: [
    { value: "", label: tx("기본") },
    { value: "gpt-6.1-sol", label: "gpt-6.1-sol" },
  ],
};

// ---------- prompts ----------

/** Connections that can search the web: the CLIs have the tools, API keys and Ollama don't here. */
export function supportsWeb(provider: string): boolean {
  return provider === "claude" || provider === "codex";
}

// 사용자가 웹 검색을 분명히 요청했는지. 맞으면 노트를 보내지 않고 바로 검색하므로,
// 내 노트를 찾는 말("지난주 회의 결정 찾아줘")을 잘못 잡지 않도록 좁게 판단한다.
// "요약 노트를 만들어 줘"의 노트는 결과물이므로 찾을 대상일 때만 내 노트로 본다.
const ABOUT_NOTES = /(노트|메모)(에서|에\s|나|와|랑|하고|및|(을|를)?\s*(찾|검색))|(이|내|열린|현재)\s*(노트|메모)|업무|회의|프로젝트|폴더|이 글|선택한 글|내 기록|내 자료/;
const NAMES_THE_WEB =
  /(웹|인터넷|온라인|구글|네이버)(에서|으로|로)|(웹|인터넷|구글|네이버)\s*(검색|찾|조사)|\b(search|look up|find)\b.*\b(web|internet|online|google)\b|\b(web|internet|online)\s+search/i;
const LOOKS_UP = /검색|찾아|조사|알아봐/;
const FROM_OUTSIDE = /도서|저서|논문|뉴스|기사|영화|(^|[\s'"])책/;

export function asksForWeb(question: string): boolean {
  if (ABOUT_NOTES.test(question)) return false;
  return NAMES_THE_WEB.test(question) || (LOOKS_UP.test(question) && FROM_OUTSIDE.test(question));
}

/** The request says to use the web, possibly along with notes ("노트나 웹에서 찾아서"). */
export function namesWeb(question: string): boolean {
  return NAMES_THE_WEB.test(question);
}

const WANTS_NEW_NOTE = /새\s*(노트|메모|문서)|(노트|메모|문서)(를|로)?\s*(새로\s*)?(만들|생성)|\bnew note\b|\bcreate a note\b/i;
const WANTS_WRITING =
  /작성해\s*(줘|주)|작성\s*부탁|써\s*(줘|주세요|넣)|적어\s*(줘|주|넣)|기록해\s*(줘|주)|덧붙|추가해\s*(줘|주)|넣어\s*(줘|주)|고쳐\s*(줘|주)|수정해\s*(줘|주)|바꿔\s*(줘|주)|채워\s*(줘|주)|달아\s*(줘|주)|\b(write|draft|append)\b/i;

/**
 * What the request wants written, judged from its wording: a new note, something
 * in the open note, or (null) just an answer. It only sets the defaults; every
 * change to a note is still shown for review before it is applied.
 */
export function writeIntent(question: string): "new" | "open" | null {
  if (WANTS_NEW_NOTE.test(question)) return "new";
  return WANTS_WRITING.test(question) ? "open" : null;
}

const TEMPLATE_WORD = "템플릿|양식|서식|template";

/** The request asks for a template's format ("독서 템플릿에 맞게"), not about the templates folder. */
export function asksForTemplate(question: string): boolean {
  return new RegExp(`(${TEMPLATE_WORD})\\s*(에|으로|로|을|를|대로|처럼|형식|맞|따라)`, "i").test(question);
}

/** The template a request names, by its title with or without the word "템플릿". */
export function matchTemplate<T extends { title: string }>(question: string, templates: T[]): T | null {
  const key = (s: string) => s.normalize("NFC").replace(/\s+/g, "").toLowerCase();
  const word = (title: string) => key(title).replace(/^\d+[.\-_]*/, "").replace(new RegExp(`(${TEMPLATE_WORD})$`), "");
  const q = key(question);
  const longest = (list: T[]) => list.sort((a, b) => word(b.title).length - word(a.title).length)[0] ?? null;
  const exact = templates.filter((t) => word(t.title) && new RegExp(`${word(t.title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(${TEMPLATE_WORD})`).test(q));
  if (exact.length) return longest(exact);
  const named = [...question.normalize("NFC").matchAll(new RegExp(`(\\S+?)\\s*(${TEMPLATE_WORD})`, "gi"))].map((m) => key(m[1])).filter((w) => w.length >= 2);
  return longest(templates.filter((t) => named.some((w) => word(t.title).includes(w))));
}

const QA_BASE = [
  "너는 사용자의 개인 업무 노트를 바탕으로 답하는 한국어 도우미다.",
  "근거로 쓴 노트는 해당 문장 끝에 [[노트 제목]] 형식으로 표시한다. 제목은 note 태그의 title 값을 그대로 쓴다.",
  "답은 간결한 마크다운으로 쓴다. 인사말이나 불필요한 서론은 쓰지 않는다.",
];

/**
 * System prompt for a question. Without `web` the answer may only use the sent
 * notes; with it the AI may also search the web when the notes aren't enough.
 */
export function qaSystem(web: boolean): string {
  return [
    ...QA_BASE,
    ...(web
      ? [
          "사용자가 검색을 요청했거나 책·인물·제품처럼 노트 밖의 정보를 물으면, 노트가 있어도 반드시 웹을 검색하고 페이지를 읽어 믿을 만한 출처로 확인한다. <참고 노트>가 없어도 거절하지 않는다.",
          "그 밖에는 <참고 노트>로 답할 수 있으면 노트를 우선하고, 노트에 없거나 최신 정보가 필요하면 웹을 검색한다.",
          "웹에서 확인한 내용은 해당 문장 끝에 [제목](URL) 링크로 출처를 단다. 확인하지 못한 내용은 쓰지 않거나 '확인 필요'라고 밝힌다.",
          "노트의 문장이나 고유한 내용(이름, 수치, 내부 정보)을 검색어에 넣지 말고, 질문의 일반적인 표현으로만 검색한다.",
          "진행 상황 설명 없이 최종 답만 쓴다.",
        ]
      : ["<참고 노트>에 있는 내용만 근거로 답한다. 노트에 없는 내용은 추측하지 말고 노트에서 찾지 못했다고 말한다."]),
  ].join("\n");
}

export type WriteTask = "summarize" | "polish" | "continue" | "translate";

export const WRITE_LABEL: Record<WriteTask, string> = {
  summarize: tx("요약"),
  polish: tx("다듬기"),
  continue: tx("이어 쓰기"),
  translate: tx("영어로 번역"),
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
  opts: { web?: boolean; onProgress?: (m: string) => void } = {},
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
      else if (e.kind === "progress") opts.onProgress?.(e.message);
      else if (e.kind === "done") {
        onText(e.text);
        resolve({ text: e.text, cost: e.cost_usd });
      } else if (e.kind === "error") reject(new Error(e.message));
    };
    api.aiRun(id, provider, system, prompt, notes, aiPrefs.model(provider) || null, !!opts.web, onEvent).catch((err) => reject(err instanceof Error ? err : new Error(String((err as { message?: string })?.message ?? err))));
  });
  return { id, done, cancel: () => void api.aiCancel(id).catch(() => {}) };
}

export function totalChars(notes: ContextNote[]): number {
  return notes.reduce((n, x) => n + x.chars, 0);
}
