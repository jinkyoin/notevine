// 화면 언어 (FR-UI-03). 화면 글은 한국어로 쓰고 tx(…)로 감싸면, 영어 화면에서는
// i18n/en.json에서 같은 키의 영어를 찾아 보여 준다(없으면 한국어 그대로). {0}, {1}은 값 자리.
// 노트 내용·폴더 이름·AI에 보내는 지시문은 데이터라 번역하지 않는다.
import en from "./i18n/en.json";

export type Lang = "ko" | "en";

const STORE_KEY = "notevine.lang";

function stored(): Lang {
  try {
    return localStorage.getItem(STORE_KEY) === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

let lang: Lang = stored();
const table = en as Record<string, string>;

export function getLang(): Lang {
  return lang;
}

/** Saves the language and reloads the window, so every screen (and text made at start-up) uses it. */
export function setLang(next: Lang) {
  if (next === lang) return;
  try {
    localStorage.setItem(STORE_KEY, next);
  } catch {
    // no storage: the choice lasts until the window reloads
  }
  lang = next;
  window.location.reload();
}

/** The screen text for Korean `ko` in the current language, with {0}, {1}… filled from `args`. */
export function tx(ko: string, ...args: unknown[]): string {
  const s = lang === "en" ? (table[ko] ?? ko) : ko;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s;
}

/** Locale for dates and times on screen. */
export function dateLocale(): string {
  return lang === "en" ? "en-US" : "ko-KR";
}

/** For tests: switch without reloading. */
export function setLangForTest(next: Lang) {
  lang = next;
}
