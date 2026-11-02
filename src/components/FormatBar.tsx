// SCR-04 서식 막대: 자주 쓰는 마크다운을 아이콘으로 넣고, 편집/읽기 모드를 바꾼다.
import { useEffect, useRef, useState } from "react";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import { callout, codeBlock, insertBlock, TABLE, toggleLines, toggleWrap, webLink, wikiLink } from "../editor/format";
import { CALLOUTS } from "../lib/callout";
import { applyColor, BG_COLORS, TEXT_COLORS, type ColorProp } from "../editor/colors";
import { useApp } from "../store";

type Action = (s: EditorState) => TransactionSpec;

interface Tool {
  label: string;
  keys?: string;
  icon: React.ReactNode;
  run: Action;
}

const svg = (d: React.ReactNode) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    {d}
  </svg>
);
const text = (t: string, style?: React.CSSProperties) => (
  <span className="fb-text" style={style}>
    {t}
  </span>
);

const GROUPS: Tool[][] = [
  [
    { label: "제목 1", icon: text("H1"), run: (s) => toggleLines(s, "h1") },
    { label: "제목 2", icon: text("H2"), run: (s) => toggleLines(s, "h2") },
    { label: "제목 3", icon: text("H3"), run: (s) => toggleLines(s, "h3") },
  ],
  [
    { label: "굵게", keys: "Ctrl+B", icon: text("B", { fontWeight: 800 }), run: (s) => toggleWrap(s, "**") },
    { label: "기울임", keys: "Ctrl+I", icon: text("I", { fontStyle: "italic", fontFamily: "Georgia, serif" }), run: (s) => toggleWrap(s, "*") },
    { label: "취소선", keys: "Ctrl+Shift+X", icon: text("S", { textDecoration: "line-through" }), run: (s) => toggleWrap(s, "~~") },
    {
      label: "형광펜 강조",
      keys: "Ctrl+Shift+H",
      icon: svg(
        <>
          <path d="M9.5 2.5l4 4-6 6H3.5v-4z" />
          <path d="M2 14.5h12" />
        </>,
      ),
      run: (s) => toggleWrap(s, "=="),
    },
    { label: "인라인 코드", keys: "Ctrl+`", icon: svg(<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />), run: (s) => toggleWrap(s, "`") },
  ],
  [
    {
      label: "글머리 목록",
      icon: svg(
        <>
          <circle cx="3" cy="4.5" r="1" className="dot" />
          <circle cx="3" cy="8" r="1" className="dot" />
          <circle cx="3" cy="11.5" r="1" className="dot" />
          <path d="M6 4.5h8M6 8h8M6 11.5h8" />
        </>,
      ),
      run: (s) => toggleLines(s, "bullet"),
    },
    {
      label: "번호 목록",
      icon: svg(
        <>
          <path d="M2.5 3.5h1v3M2.3 9.5h1.8l-1.8 2.5h1.9" />
          <path d="M7 4.5h7M7 8h7M7 11.5h7" />
        </>,
      ),
      run: (s) => toggleLines(s, "number"),
    },
    {
      label: "체크리스트",
      keys: "Ctrl+L",
      icon: svg(
        <>
          <rect x="1.8" y="2.8" width="4" height="4" rx="0.8" />
          <path d="M2.6 4.8l1 1 1.6-2" />
          <rect x="1.8" y="9.2" width="4" height="4" rx="0.8" />
          <path d="M8 4.8h6M8 11.2h6" />
        </>,
      ),
      run: (s) => toggleLines(s, "task"),
    },
    {
      label: "인용",
      icon: svg(
        <>
          <path d="M3 3.5v9" />
          <path d="M6 5h8M6 8h8M6 11h5" />
        </>,
      ),
      run: (s) => toggleLines(s, "quote"),
    },
  ],
  [
    {
      label: "노트 링크 [[ ]]",
      icon: svg(<path d="M5.5 3H3.5v10h2M10.5 3h2v10h-2M7 3H6v10h1M9 3h1v10H9" />),
      run: wikiLink,
    },
    {
      label: "웹 링크",
      keys: "Ctrl+K",
      icon: svg(
        <>
          <path d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1" />
          <path d="M9.2 6.8a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
        </>,
      ),
      run: webLink,
    },
    {
      label: "표",
      icon: svg(
        <>
          <rect x="2" y="3" width="12" height="10" rx="1" />
          <path d="M2 6.5h12M2 9.8h12M7 3v10" />
        </>,
      ),
      run: (s) => insertBlock(s, TABLE, TABLE.lastIndexOf("|  |") + 2),
    },
    {
      label: "코드 블록",
      icon: svg(
        <>
          <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2" />
          <path d="M6 6.2L4 8l2 1.8M10 6.2L12 8l-2 1.8" />
        </>,
      ),
      run: codeBlock,
    },
    { label: "구분선", icon: svg(<path d="M2 8h12" />), run: (s) => insertBlock(s, "---") },
  ],
];

const LAST_KEY: Record<ColorProp, string> = { color: "notevine.fmt.color", "background-color": "notevine.fmt.bg" };

function readLast(prop: ColorProp, fallback: string): string {
  try {
    return localStorage.getItem(LAST_KEY[prop]) || fallback;
  } catch {
    return fallback;
  }
}

/** Text or background color: a button that opens a palette (plus "none"). */
function ColorButton({ prop, apply, disabled }: { prop: ColorProp; apply: (a: Action) => void; disabled: boolean }) {
  const palette = prop === "color" ? TEXT_COLORS : BG_COLORS;
  const label = prop === "color" ? "글자 색" : "배경색";
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState(() => readLast(prop, palette[0].value));
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const choose = (value: string | null) => {
    setOpen(false);
    if (value) {
      setLast(value);
      try {
        localStorage.setItem(LAST_KEY[prop], value);
      } catch {
        /* remembering the color is only a convenience */
      }
    }
    apply((s) => applyColor(s, prop, value));
  };

  return (
    <div className="fb-color" ref={box}>
      <button
        className="fb-btn"
        data-tip={`${label} (선택한 글)`}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        {prop === "color" ? (
          <span className="fb-color-a">
            A<span className="fb-color-bar" style={{ background: last }} />
          </span>
        ) : (
          <span className="fb-color-a fb-color-bg" style={{ background: last }}>
            A
          </span>
        )}
      </button>
      {open && (
        <div className="fb-palette" role="menu" aria-label={label}>
          {palette.map((c) => (
            <button
              key={c.value}
              role="menuitem"
              className={`fb-swatch ${c.value === last ? "on" : ""}`}
              title={c.name}
              aria-label={`${label}: ${c.name}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(c.value)}
            >
              {prop === "color" ? <span style={{ color: c.value }}>A</span> : <span style={{ background: c.value }}>A</span>}
            </button>
          ))}
          <button
            role="menuitem"
            className="fb-swatch-none"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(null)}
          >
            {prop === "color" ? "기본 색으로" : "배경 없애기"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Callout box (`> [!중요]`): a button that opens the list of importance types. */
function CalloutButton({ apply, disabled }: { apply: (a: Action) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="fb-color" ref={box}>
      <button
        className="fb-btn"
        data-tip="강조 상자 (중요도 표시)"
        aria-label="강조 상자"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        {svg(
          <>
            <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
            <path d="M8 5v4M8 11.2v.1" />
          </>,
        )}
      </button>
      {open && (
        <div className="fb-callouts" role="menu" aria-label="강조 상자">
          {CALLOUTS.map((c) => (
            <button
              key={c.kind}
              role="menuitem"
              className={`fb-callout callout-${c.kind}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                apply((s) => callout(s, c));
              }}
            >
              <span className="callout-icon">{c.icon}</span>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** [편집 | 읽기] switch, shown in the title row (Ctrl+E). */
export function ModeSwitch({ readMode, setReadMode }: { readMode: boolean; setReadMode: (on: boolean) => void }) {
  return (
    <div className="fb-mode" role="tablist" title="편집/읽기 전환 (Ctrl+E)">
      <button role="tab" aria-selected={!readMode} className={!readMode ? "on" : ""} onClick={() => setReadMode(false)}>
        {svg(<path d="M10.5 2.5l3 3-8 8h-3v-3z" />)}
        편집
      </button>
      <button role="tab" aria-selected={readMode} className={readMode ? "on" : ""} onClick={() => setReadMode(true)}>
        {svg(
          <>
            <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
            <circle cx="8" cy="8" r="2" />
          </>,
        )}
        읽기
      </button>
    </div>
  );
}

/**
 * The buttons' tooltip, shown above the button: the browser's own (title) sits below
 * the pointer, where the pointer hides it.
 */
function useTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const show = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (!el) return setTip(null);
    const r = el.getBoundingClientRect();
    setTip({ text: el.dataset.tip!, x: r.left + r.width / 2, y: r.top });
  };
  const hide = () => setTip(null);
  const node = tip && (
    <div className="fb-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  );
  return { show, hide, node };
}

export function FormatBar({ apply, readMode }: { apply: (a: Action) => void; readMode: boolean }) {
  const tip = useTip();
  return (
    <div
      className="format-bar"
      role="toolbar"
      aria-label="서식"
      onMouseOver={tip.show}
      onMouseLeave={tip.hide}
      onMouseDown={tip.hide}
    >
      {tip.node}
      {GROUPS.map((g, i) => (
        <div className="fb-group" key={i}>
          {g.map((t) => (
            <button
              key={t.label}
              className="fb-btn"
              data-tip={t.keys ? `${t.label} (${t.keys})` : t.label}
              aria-label={t.label}
              disabled={readMode}
              // Keep the editor's focus and selection.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => apply(t.run)}
            >
              {t.icon}
            </button>
          ))}
          {/* Colors sit with the other text styles. */}
          {i === 1 && (
            <>
              <ColorButton prop="color" apply={apply} disabled={readMode} />
              <ColorButton prop="background-color" apply={apply} disabled={readMode} />
            </>
          )}
          {i === 2 && <CalloutButton apply={apply} disabled={readMode} />}
        </div>
      ))}
      {/* Help stays usable in read mode too. */}
      <div className="fb-group">
        <button
          className="fb-btn"
          data-tip="마크다운 문법 도움말 (F1)"
          aria-label="마크다운 문법 도움말"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useApp.getState().setModal("mdHelp")}
        >
          {text("?")}
        </button>
      </div>
    </div>
  );
}

export type { Action as FormatAction };
