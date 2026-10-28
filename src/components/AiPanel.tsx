// SCR-18 AI 패널: 노트에 질문하고, 출처 링크가 달린 답을 받는다 (FR-AI-01·02·06).
import { useEffect, useRef, useState } from "react";
import { useAi } from "../aiStore";
import { useApp } from "../store";

/** Answer text: [[links]] are clickable, **bold** and "# heading" lines are styled; the rest stays plain. */
function AnswerText({ text }: { text: string }) {
  const followLink = useApp((s) => s.followLink);
  const inline = (line: string, key: string) =>
    line.split(/(\[\[[^[\]\n]+?\]\]|\*\*[^*\n]+?\*\*)/g).map((p, i) => {
      const link = /^\[\[([^[\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(p);
      if (link) {
        return (
          <button key={`${key}-${i}`} className="ai-link" onClick={() => void followLink(link[1].trim())}>
            {link[1].trim()}
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

export function AiPanel() {
  const { enabled, providers, chat, running } = useAi();
  const { detect, setEnabled, setProvider, current, ask, stop, newChat, saveAnswer } = useAi.getState();
  const providerId = useAi((s) => s.providerId);
  const [q, setQ] = useState("");
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
        <h3 className="panel-heading">AI 도우미</h3>
        <p className="small pad">
          노트에 질문하고, 글을 요약·다듬고, 주간 회고를 만듭니다. PC에 로그인된 <b>Claude Code</b>나 <b>Codex CLI</b>를
          그대로 씁니다.
        </p>
        <p className="muted small pad">
          켜면 질문할 때마다 보낼 노트를 먼저 보여 드리고, 확인한 것만 해당 AI 서비스(Anthropic·OpenAI)로 보냅니다.
        </p>
        <div className="pad">
          <button className="btn primary small" onClick={() => setEnabled(true)}>
            AI 도우미 켜기
          </button>
        </div>
      </section>
    );
  }

  const usable = (providers ?? []).filter((p) => p.available && p.logged_in !== false);
  const cur = current();

  return (
    <section className="ai-panel">
      <div className="ai-head">
        {providers === null ? (
          <span className="muted small">AI 찾는 중…</span>
        ) : usable.length === 0 ? (
          <span className="error small">사용할 수 있는 AI가 없습니다</span>
        ) : (
          <select value={cur?.id ?? providerId} onChange={(e) => setProvider(e.target.value)} title="사용할 AI">
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button className="btn ghost small" onClick={newChat} disabled={!!running || chat.length === 0}>
          새 대화
        </button>
      </div>

      {providers !== null && usable.length === 0 && (
        <div className="pad small">
          {(providers ?? []).map((p) => (
            <p key={p.id}>
              <b>{p.name}</b>: {p.detail ?? "사용할 수 없습니다"}
            </p>
          ))}
          <button className="btn small" onClick={() => void detect()}>
            다시 찾기
          </button>
        </div>
      )}

      <div className="ai-chat">
        {chat.length === 0 && usable.length > 0 && (
          <p className="muted small pad">
            예: "지난주 회의에서 결정한 것 정리해 줘", "자동화 관련 아이디어를 모아 줘". 관련 노트를 찾아 보내기 전에 보여
            드립니다.
          </p>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role}`}>
            {m.role === "user" ? (
              <div className="ai-text">{m.text}</div>
            ) : (
              <>
                {m.text ? <AnswerText text={m.text} /> : m.streaming && <div className="muted small">답을 기다리는 중…</div>}
                {m.error && <div className="error small">{m.error}</div>}
                {!m.streaming && m.text && (
                  <div className="ai-actions">
                    <button className="btn ghost small" onClick={() => void saveAnswer(i)}>
                      새 노트로 저장
                    </button>
                    <button className="btn ghost small" onClick={() => void navigator.clipboard.writeText(m.text)}>
                      복사
                    </button>
                    {m.sources && m.sources.length > 0 && <span className="muted small">참고 노트 {m.sources.length}개</span>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <form
        className="ai-input"
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
          placeholder={usable.length ? "노트에 대해 질문하세요 (Enter 보내기, Shift+Enter 줄바꿈)" : "AI를 연결하면 질문할 수 있습니다"}
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
          <button type="button" className="btn small" onClick={stop}>
            중지
          </button>
        ) : (
          <button type="submit" className="btn primary small" disabled={!q.trim() || !usable.length}>
            보내기
          </button>
        )}
      </form>
    </section>
  );
}
