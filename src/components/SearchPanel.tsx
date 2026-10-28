// SCR-05 검색·필터: 검색창 문법 + 조건(속성·날짜) + 강조된 결과.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type DateFilter, type PropFilter, type SearchResult } from "../api";
import { useApp } from "../store";
import { parseQuery } from "../lib/query";

const DEBOUNCE_MS = 200;
const DAY = 24 * 60 * 60 * 1000;

type Range = "all" | "today" | "7d" | "30d";
const RANGE_LABEL: Record<Range, string> = { all: "전체 기간", today: "오늘", "7d": "최근 7일", "30d": "최근 30일" };
const OP_LABEL: Record<PropFilter["op"], string> = { eq: "=", ne: "≠", contains: "포함", empty: "비어 있음" };

function dateFilter(field: DateFilter["field"], range: Range): DateFilter | null {
  if (range === "all") return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = range === "today" ? 0 : range === "7d" ? 6 : 29;
  return { field, from: start.getTime() - days * DAY, to: null };
}

export function SearchPanel() {
  const openNote = useApp((s) => s.openNote);
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  const focusSeq = useApp((s) => s.searchFocusSeq);
  const templateFolder = useApp((s) => s.config.template_folder);
  const [text, setText] = useState("");
  const [extra, setExtra] = useState<PropFilter[]>([]);
  const [dateField, setDateField] = useState<DateFilter["field"]>("modified");
  const [range, setRange] = useState<Range>("all");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSeq]);

  const query = useMemo(() => {
    const q = parseQuery(text);
    q.props = [...q.props, ...extra];
    q.date = dateFilter(dateField, range);
    q.limit = 100;
    return q;
  }, [text, extra, dateField, range]);

  useEffect(() => {
    let stale = false;
    const t = window.setTimeout(() => {
      api
        .search(query)
        .then((r) => {
          if (stale) return;
          // Templates are scaffolding, not notes: keep them out of results.
          const hits = r.hits.filter((h) => !h.path.startsWith(templateFolder + "/"));
          setResult({ ...r, hits, total: r.total - (r.hits.length - hits.length) });
          setError(null);
        })
        .catch((e) => !stale && setError(errorMessage(e)));
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [query, savedSeq, externalSeq, templateFolder]);

  return (
    <div className="search-panel">
      <div className="search-box">
        <input
          ref={input}
          className="search-input"
          placeholder='검색  (#태그  status:검토  "정확한 구")'
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setText("")}
        />
      </div>

      <div className="filters">
        <div className="filter-row">
          <select value={dateField} onChange={(e) => setDateField(e.target.value as DateFilter["field"])}>
            <option value="modified">수정일</option>
            <option value="created">생성일</option>
          </select>
          <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
            {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
              <option key={r} value={r}>
                {RANGE_LABEL[r]}
              </option>
            ))}
          </select>
          <button className="btn ghost small" onClick={() => setAdding((v) => !v)}>
            ＋ 조건
          </button>
        </div>
        {adding && (
          <ConditionForm
            onAdd={(f) => {
              setExtra([...extra, f]);
              setAdding(false);
            }}
          />
        )}
        {extra.map((f, i) => (
          <div key={i} className="chip-filter">
            <span>
              {f.key} {OP_LABEL[f.op]} {f.value ?? ""}
            </span>
            <button className="icon-btn" title="조건 삭제" onClick={() => setExtra(extra.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
      </div>

      {error && <p className="error pad small">{error}</p>}
      {result && (
        <p className="muted small pad result-summary">
          결과 {result.total}개 · {result.took_ms}ms
        </p>
      )}
      <ul className="results">
        {result?.hits.map((h) => (
          <li key={h.path} onClick={() => openNote(h.path, h.line ?? undefined)} title={h.path}>
            <div className="r-title">{h.title}</div>
            {h.parts.length > 0 && (
              <div className="r-snippet">
                {h.parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
              </div>
            )}
            <div className="r-meta">
              {h.path.includes("/") ? h.path.slice(0, h.path.lastIndexOf("/")) : "맨 위 폴더"} ·{" "}
              {new Date(h.mtime).toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" })}
            </div>
          </li>
        ))}
      </ul>
      {result && result.total === 0 && <p className="muted small pad">결과 없음 · 조건을 줄여 보세요</p>}
    </div>
  );
}

function ConditionForm({ onAdd }: { onAdd: (f: PropFilter) => void }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [values, setValues] = useState<string[]>([]);
  const [key, setKey] = useState("");
  const [op, setOp] = useState<PropFilter["op"]>("eq");
  const [value, setValue] = useState("");

  useEffect(() => {
    api.propertyKeys().then(setKeys).catch(() => setKeys([]));
  }, []);
  useEffect(() => {
    if (key) api.propertyValues(key).then(setValues).catch(() => setValues([]));
  }, [key]);

  const submit = () => key.trim() && onAdd({ key: key.trim(), op, value: op === "empty" ? null : value });
  return (
    <div className="condition-form" onKeyDown={(e) => e.key === "Enter" && submit()}>
      <input list="nv-prop-keys" placeholder="속성" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
      <datalist id="nv-prop-keys">
        {keys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <select value={op} onChange={(e) => setOp(e.target.value as PropFilter["op"])}>
        {(Object.keys(OP_LABEL) as PropFilter["op"][]).map((o) => (
          <option key={o} value={o}>
            {OP_LABEL[o]}
          </option>
        ))}
      </select>
      {op !== "empty" && (
        <>
          <input list="nv-prop-values" placeholder="값" value={value} onChange={(e) => setValue(e.target.value)} />
          <datalist id="nv-prop-values">
            {values.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </>
      )}
      <button className="btn small primary" onClick={submit}>
        추가
      </button>
    </div>
  );
}
