// SCR-08 속성 패널: frontmatter를 유형별 입력으로 보여 주고 고친다 (FR-PRP-02·03).
// 편집기 텍스트가 원본이다. 패널에서 바꾸면 편집기 텍스트를 고치고, 자동 저장이 디스크에 쓴다.
import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { useApp } from "../store";
import { readFrontmatter, setProperty, typeOf, type Prop } from "../lib/frontmatter";

export function PropertiesPanel() {
  const docText = useApp((s) => s.docText);
  const editText = useApp((s) => s.editText);
  const toast = useApp((s) => s.toast);
  const fm = useMemo(() => (docText === null ? null : readFrontmatter(docText)), [docText]);
  const [keys, setKeys] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    api.propertyKeys().then(setKeys).catch(() => setKeys([]));
  }, [docText === null]);

  if (!fm) return null;

  const commit = (key: string, value: Prop["value"] | undefined) => {
    const ok = editText((t) => setProperty(t, key, value));
    if (!ok) toast("속성 YAML에 문법 오류가 있어 고칠 수 없습니다. 편집기에서 먼저 고쳐 주세요", "error");
  };

  return (
    <section className="panel-section props-panel">
      <h3 className="panel-heading">속성</h3>
      {fm.error && <p className="props-error">YAML 오류: {fm.error}</p>}
      {fm.props.map((p) => (
        <PropRow key={p.key} prop={p} onChange={(v) => commit(p.key, v)} onRemove={() => commit(p.key, undefined)} />
      ))}
      <div className="prop-add">
        <input
          list="nv-all-keys"
          placeholder="＋ 속성 추가"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            const k = newKey.trim();
            if (!k) return;
            if (fm.props.some((p) => p.key === k)) return toast(`"${k}" 속성이 이미 있습니다`);
            commit(k, k.toLowerCase() === "tags" ? [] : "");
            setNewKey("");
          }}
        />
        <datalist id="nv-all-keys">
          {keys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </div>
    </section>
  );
}

function PropRow({ prop, onChange, onRemove }: { prop: Prop; onChange: (v: Prop["value"]) => void; onRemove: () => void }) {
  const [suggest, setSuggest] = useState<string[]>([]);
  const listId = `nv-vals-${prop.key}`;
  const loadSuggest = () => api.propertyValues(prop.key).then(setSuggest).catch(() => {});

  let input: React.ReactNode;
  switch (prop.type) {
    case "list": {
      const items = prop.value as string[];
      input = (
        <div className="chips">
          {items.map((v, i) => (
            <span key={i} className="chip">
              {v}
              <button title="삭제" onClick={() => onChange(items.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
          <input
            className="chip-input"
            list={listId}
            placeholder="＋"
            onFocus={loadSuggest}
            onKeyDown={(e) => {
              const v = e.currentTarget.value.trim().replace(/^#/, "");
              if (e.key !== "Enter" || e.nativeEvent.isComposing || !v) return;
              if (!items.includes(v)) onChange([...items, v]);
              e.currentTarget.value = "";
            }}
          />
        </div>
      );
      break;
    }
    case "bool":
      input = <input type="checkbox" checked={prop.value as boolean} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case "date":
      input = (
        <input
          type="date"
          value={String(prop.value).slice(0, 10)}
          onChange={(e) => e.target.value && onChange(e.target.value)}
        />
      );
      break;
    default:
      input = (
        <div className="prop-text">
          <TextValue value={String(prop.value)} listId={listId} onFocus={loadSuggest} onCommit={(v) => {
            // Keep numbers numeric; anything else is stored as text and re-typed on read.
            const asNum = prop.type === "number" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
            onChange(asNum);
          }} />
          {prop.type === "url" && (
            <button className="icon-btn" title="브라우저로 열기" onClick={() => void openUrl(String(prop.value)).catch(() => {})}>
              ↗
            </button>
          )}
        </div>
      );
  }

  return (
    <div className={`prop-row t-${prop.type}`}>
      <span className="prop-key" title={`${prop.key} (${typeLabel(prop.type)})`}>
        {prop.key}
      </span>
      <div className="prop-value">{input}</div>
      <button className="icon-btn prop-remove" title="속성 삭제" onClick={onRemove}>
        ×
      </button>
      <datalist id={listId}>
        {suggest.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
    </div>
  );
}

/** Text input that commits on Enter or blur, so typing doesn't rewrite the note per keystroke. */
function TextValue({ value, listId, onFocus, onCommit }: { value: string; listId: string; onFocus: () => void; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <input
      list={listId}
      value={draft}
      onFocus={onFocus}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

function typeLabel(t: ReturnType<typeof typeOf>) {
  return { text: "텍스트", number: "숫자", bool: "예/아니오", date: "날짜", url: "URL", list: "목록" }[t];
}
