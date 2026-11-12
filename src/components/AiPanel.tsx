// SCR-18 AI 패널: 노트에 질문하고, 출처 링크가 달린 답을 받는다 (FR-AI-01·02·06).
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAi } from "../aiStore";
import { API_DEFAULT_LABEL, API_PROVIDERS, INSTALL_COMMAND, isLoginError, MODEL_OPTIONS, needsLogin, supportsWeb } from "../ai";
import { api, type AiProvider } from "../api";
import { useApp } from "../store";
import { TREE_DRAG_TYPE } from "../editor/attachments";
import { noteTitle } from "../lib/tree";

import { tx } from "../i18n";
/** Answer text: [[links]] are clickable, **bold** and "# heading" lines are styled; the rest stays plain. */
function AnswerText({ text }: { text: string }) {
  const followLink = useApp((s) => s.followLink);
  const inline = (line: string, key: string) =>
    line.split(/(\[\[[^[\]\n]+?\]\]|\[[^[\]\n]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*\n]+?\*\*)/g).map((p, i) => {
      const link = /^\[\[([^[\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(p);
      if (link) {
        return (
          <button key={`${key}-${i}`} className="ai-link" onClick={() => void followLink(link[1].trim())}>
            {link[1].trim()}
          </button>
        );
      }
      // Web sources open in the browser.
      const web = /^\[([^[\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(p);
      if (web) {
        return (
          <button key={`${key}-${i}`} className="ai-link web" title={web[2]} onClick={() => void openUrl(web[2]).catch(() => {})}>
            {web[1]}
          </button>
        );
      }
      if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={`${key}-${i}`}>{p.slice(2, -2)}</strong>;
      return <span key={`${key}-${i}`}>{p}</span>;
    });
  return (
    <div className="ai-text">
      {text.split("\n").map((line, i) => {
        const h = /^#{1,6}\s+(.*)$/.exec(line);
        return (
          <div key={i} className={h ? "ai-h" : undefined}>
            {line ? inline(h ? h[1] : line, String(i)) : " "}
          </div>
        );
      })}
    </div>
  );
}

/** What to do about an AI that cannot be used: log in, or install it. */
export function ProviderFix({ p }: { p: AiProvider }) {
  const loggingIn = useAi((s) => s.loggingIn);
  const { login } = useAi.getState();
  if (needsLogin(p)) {
    return (
      <button className="btn primary small" disabled={!!loggingIn} onClick={() => void login(p.id)}>
        {loggingIn === p.id ? tx("로그인 창에서 진행 중…") : tx("로그인")}
      </button>
    );
  }
  const cmd = INSTALL_COMMAND[p.id];
  if (p.version === null && cmd) {
    return (
      <div className="ai-install">
        <span className="muted small">{tx("PowerShell에서 설치한 뒤 다시 찾기를 누르세요")}</span>
        <div className="ai-install-row">
          <code>{cmd}</code>
          <button className="btn ghost small" onClick={() => void navigator.clipboard.writeText(cmd)}>
            {tx("복사")}
          </button>
        </div>
      </div>
    );
  }
  return null;
}

const apiModels = new Map<string, Promise<string[]>>();

/** Asks the service for its models again next time (after a key or address changed). */
export function forgetApiModels(provider: string) {
  apiModels.delete(provider);
}

/** For an API provider or Ollama, the models it offers (asked once per app run); null otherwise. */
function useApiModels(provider: string): string[] | null {
  const [list, setList] = useState<string[] | null>(null);
  useEffect(() => {
    setList(null);
    if (!API_PROVIDERS.includes(provider)) return;
    let live = true;
    if (!apiModels.has(provider)) apiModels.set(provider, api.aiModels(provider).catch(() => (apiModels.delete(provider), [])));
    void apiModels.get(provider)!.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [provider]);
  return list;
}

/** Model choice for the current AI: presets, or any name typed in. */
function ModelPicker({
  provider,
  value,
  custom,
  setCustom,
  onChange,
}: {
  provider: string;
  value: string;
  custom: boolean;
  setCustom: (v: boolean) => void;
  onChange: (m: string) => void;
}) {
  const listed = useApiModels(provider);
  const options = listed
    ? [{ value: "", label: API_DEFAULT_LABEL[provider] ?? tx("기본") }, ...listed.map((m) => ({ value: m, label: m }))]
    : (MODEL_OPTIONS[provider] ?? [{ value: "", label: tx("기본") }]);
  const known = options.some((o) => o.value === value);
  if (custom || !known) {
    return (
      <input
        className="ai-model-input"
        autoFocus={custom}
        defaultValue={value}
        placeholder={tx("모델 이름")}
        title={tx("CLI에 넘길 모델 이름. Enter로 정하고, 비우면 목록으로 돌아갑니다")}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = value;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          onChange(e.target.value);
          if (!e.target.value.trim()) setCustom(false);
        }}
      />
    );
  }
  return (
    <select
      value={value}
      title={tx("모델")}
      onChange={(e) => {
        if (e.target.value === "__custom") setCustom(true);
        else onChange(e.target.value);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      <option value="__custom">{tx("직접 입력…")}</option>
    </select>
  );
}

export function AiPanel() {
  const { enabled, providers, chat, running } = useAi();
  const { detect, setEnabled, setProvider, setModel, current, ask, stop, newChat, saveAnswer, login, reviewEdits } = useAi.getState();
  const loggingIn = useAi((s) => s.loggingIn);
  const providerId = useAi((s) => s.providerId);
  const models = useAi((s) => s.models);
  const [customModel, setCustomModel] = useState(false);
  const [q, setQ] = useState("");
  const [dropping, setDropping] = useState(false);
  const webSearch = useAi((s) => s.webSearch);
  const { attach, setWebSearch } = useAi.getState();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (enabled && !providers) void detect();
  }, [enabled, providers, detect]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [chat]);

  if (!enabled) {
    return (
      <section className="panel-section ai-off">
        <h3 className="panel-heading">{tx("AI 도우미")}</h3>
        <p className="small pad">
          {tx("노트에 질문하고, 글을 요약·다듬고, 주간 회고를 만듭니다. PC에 로그인된")}{" "} <b>Claude Code</b>{tx("나")}{" "} <b>Codex CLI</b>{tx("를 그대로 씁니다.")}
        </p>
        <p className="muted small pad">
          {tx("노트는 AI 입력창에 끌어다 놓은 것만 해당 AI 서비스(Anthropic·OpenAI)로 보냅니다. #비공개 태그가 있는 노트는 보내지 않습니다.")}
        </p>
        <div className="pad">
          <button className="btn primary small" onClick={() => setEnabled(true)}>
            {tx("AI 도우미 켜기")}
          </button>
        </div>
      </section>
    );
  }

  const usable = (providers ?? []).filter((p) => p.available && p.logged_in !== false);
  const cur = current();

  return (
    <section className="ai-panel">
      <div className="ai-title-row">
        <span className="panel-heading ai-title">{tx("AI 도우미")}</span>
        <span className="spacer" />
        <button className="btn ghost small" onClick={newChat} disabled={!!running || chat.length === 0}>
          {tx("새 대화")}
        </button>
      </div>
      <div className="ai-head">
        {providers === null ? (
          <span className="muted small">{tx("AI 찾는 중…")}</span>
        ) : usable.length === 0 ? (
          <span className="error small">{tx("사용할 수 있는 AI가 없습니다")}</span>
        ) : (
          <select value={cur?.id ?? providerId} onChange={(e) => setProvider(e.target.value)} title={tx("사용할 AI")}>
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {cur && <ModelPicker provider={cur.id} value={models[cur.id] ?? ""} custom={customModel} setCustom={setCustomModel} onChange={(m) => setModel(cur.id, m)} />}
      </div>

      {providers !== null && usable.length === 0 && (
        <div className="pad small ai-connect">
          {(providers ?? []).map((p) => (
            <div key={p.id} className="ai-connect-item">
              <div>
                <b>{p.name}</b>: {p.detail ?? tx("사용할 수 없습니다")}
              </div>
              <ProviderFix p={p} />
            </div>
          ))}
          <p className="muted small">{tx("로그인은 각 AI의 공식 로그인 창에서 합니다. Notevine은 로그인 정보를 보지 않습니다.")}</p>
          <button className="btn small" onClick={() => void detect(true)}>
            {tx("다시 찾기")}
          </button>
        </div>
      )}

      <div className="ai-chat">
        {chat.length === 0 && usable.length > 0 && (
          <p className="muted small pad">
            {tx("예: 회의록 폴더를 끌어다 놓고 \"지난주에 결정한 것 정리해 줘\". 노트는 끌어다 놓은 것만 보내고, 작성한 내용은 확인한 것만 적용합니다.")}
          </p>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role}`}>
            {m.role === "user" ? (
              <div className="ai-text">{m.text}</div>
            ) : (
              <>
                {m.text ? <AnswerText text={m.text} /> : m.streaming && <div className="muted small">{tx("답을 기다리는 중…")}</div>}
                {m.streaming && m.progress && m.progress.length > 0 && (
                  <ul className="ai-progress small muted">
                    {m.progress.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ul>
                )}
                {m.error && <div className="error small">{m.error}</div>}
                {m.error && isLoginError(m.error) && (
                  <div className="ai-actions">
                    <button
                      className="btn primary small"
                      disabled={!!loggingIn}
                      onClick={() => void login(m.provider ?? current()?.id ?? "claude")}
                    >
                      {loggingIn ? tx("로그인 창에서 진행 중…") : tx("로그인")}
                    </button>
                  </div>
                )}
                {m.proposal && (
                  <div className="ai-actions">
                    <button className="btn primary small" onClick={() => reviewEdits(i)}>
                      {tx("바뀌는 부분 보기")}
                    </button>
                  </div>
                )}
                {m.applied !== undefined && <div className="muted small">{tx("노트 {0}개에 적용했습니다", m.applied)}</div>}
                {!m.streaming && m.text && !m.proposal && m.applied === undefined && (
                  <div className="ai-actions">
                    <button className="btn ghost small" onClick={() => void saveAnswer(i)}>
                      {tx("새 노트로 저장")}
                    </button>
                    <button className="btn ghost small" onClick={() => void navigator.clipboard.writeText(m.text)}>
                      {tx("복사")}
                    </button>
                    {m.sources && m.sources.length > 0 && <span className="muted small">{tx("참고 노트 {0}개", m.sources.length)}</span>}
                    {m.model && <span className="muted small">· {m.model}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <AttachedChips />
      <form
        className={`ai-input${dropping ? " dropping" : ""}`}
        // Notes and folders dragged from the file tree are what a question sends (FR-AI-03).
        onDragOver={(e) => {
          const t = e.dataTransfer.types;
          if (!t.includes(TREE_DRAG_TYPE) && !t.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = t.includes(TREE_DRAG_TYPE) ? "link" : "none";
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          const path = e.dataTransfer.getData(TREE_DRAG_TYPE);
          if (path) {
            e.preventDefault();
            void attach(path);
          } else if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            useApp.getState().toast(tx("왼쪽 파일 트리에서 노트나 폴더를 끌어다 놓으세요"), "error");
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const text = q;
          setQ("");
          void ask(text);
        }}
      >
        <textarea
          value={q}
          rows={2}
          placeholder={
            !usable.length
              ? tx("AI를 연결하면 질문할 수 있습니다")
              : tx("질문하거나 작성할 것을 쓰세요 (Enter 보내기, Shift+Enter 줄바꿈)")
          }
          disabled={!usable.length}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {running ? (
          <button type="button" className="btn small ai-send" title={tx("중지")} aria-label={tx("중지")} onClick={stop}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect className="ai-stop-icon" x="4" y="4" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className="btn primary small ai-send"
            title={tx("보내기 (Enter)")}
            aria-label={tx("보내기")}
            disabled={!q.trim() || !usable.length}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        )}
      </form>
      {usable.length > 0 && (
        <div className="ai-hint muted small">
          <span>{tx("노트에 대해 물으려면 파일 트리에서 노트나 폴더를 여기에 끌어다 놓으세요")}</span>
          {cur && supportsWeb(cur.id) && (
            <label className="ai-web-toggle" title={tx("질문할 때 웹도 찾아봅니다")}>
              <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} /> {tx("웹 검색")}
            </label>
          )}
        </div>
      )}
    </section>
  );
}

/** The notes and folders dropped on the question box; × takes one out. */
function AttachedChips() {
  const attached = useAi((s) => s.attached);
  const { detach } = useAi.getState();
  if (!attached.length) return null;
  return (
    <ul className="ai-chips" aria-label={tx("AI에 함께 보낼 노트와 파일")}>
      {attached.map((a) => {
        const files = a.files ?? [];
        const single = a.notes.length + files.length === 1 && (a.notes[0] ?? files[0]?.path) === a.path;
        const folder = !single;
        const counts = [a.notes.length ? tx("노트 {0}개", a.notes.length) : "", files.length ? tx("파일 {0}개", files.length) : ""].filter(Boolean).join(" · ");
        return (
          <li key={a.path} className="ai-chip" title={[...a.notes, ...files.map((f) => f.path)].join("\n")}>
            <span>
              {folder ? "📁" : files.length ? "📎" : "📄"} {files.length && !folder ? a.path.split("/").pop() : noteTitle(a.path)}
              {folder && <span className="muted"> ({counts || tx("노트 {0}개", 0)})</span>}
              {a.privateCount > 0 && <span className="muted"> · {tx("비공개 {0}개 제외", a.privateCount)}</span>}
              {(a.unreadCount ?? 0) > 0 && <span className="muted"> · {tx("읽지 못한 파일 {0}개 제외", a.unreadCount ?? 0)}</span>}
            </span>
            <button type="button" aria-label={tx("{0} 빼기", noteTitle(a.path))} onClick={() => detach(a.path)}>
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
