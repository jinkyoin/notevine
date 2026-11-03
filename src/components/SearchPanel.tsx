// SCR-05 검색·필터: 검색창 문법 + 조건(속성·날짜) + 강조된 결과 + 저장된 검색(FR-SRC-06).
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type DateFilter, type PropFilter, type SavedSearch, type SearchResult } from "../api";
import { useApp } from "../store";
import { openProps } from "./TabBar";
import { parseQuery } from "../lib/query";
import { sameSearch, searchLabel, upsertSearch } from "../lib/savedSearch";

import { dateLocale, tx } from "../i18n";
const DEBOUNCE_MS = 200;
const DAY = 24 * 60 * 60 * 1000;

type Range = "all" | "today" | "7d" | "30d";
const RANGE_LABEL: Record<Range, string> = { all: tx("전체 기간"), today: tx("오늘"), "7d": tx("최근 7일"), "30d": tx("최근 30일") };
const OP_LABEL: Record<PropFilter["op"], string> = { eq: "=", ne: "≠", contains: tx("포함"), empty: tx("비어 있음") };

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
  const [naming, setNaming] = useState<string | null>(null); // name being typed for ☆ 저장
  const saved = useApp((s) => s.config.saved_searches ?? []);
  const input = useRef<HTMLInputElement>(null);

  const current: SavedSearch = { name: "", text: text.trim(), filters: extra, date_field: dateField, range };
  const empty = !current.text && !extra.length && range === "all";
  const active = saved.find((s) => sameSearch(s, current));
  const apply = (s: SavedSearch) => {
    setText(s.text);
    setExtra(s.filters);
    setDateField(s.date_field);
    setRange(s.range);
    setNaming(null);
  };
  const store = (list: SavedSearch[]) => {
    const st = useApp.getState();
    void st.saveConfig({ ...st.config, saved_searches: list });
  };
  const saveAs = (name: string) => {
    if (!name.trim()) return;
    store(upsertSearch(saved, { ...current, name: name.trim() }));
    setNaming(null);
  };

  useEffect(() => {
    // A clicked #태그 fills the box once; a plain Ctrl+Shift+F keeps what was typed.
    const seed = useApp.getState().searchSeed;
    if (seed !== null) {
      setText(seed);
      useApp.setState({ searchSeed: null });
    }
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
          placeholder={tx("검색  (#태그  status:검토  \"정확한 구\")")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setText("")}
        />
        {!empty && (
          <button
            className={`icon-btn save-search${active ? " on" : ""}`}
            title={active ? tx("저장된 검색 \"{0}\"", active.name) : tx("이 검색 저장")}
            aria-label={tx("이 검색 저장")}
            onClick={() => setNaming(naming === null ? (active?.name ?? searchLabel(current)) : null)}
          >
            {active ? "★" : "☆"}
          </button>
        )}
      </div>
      {naming !== null && (
        <form
          className="condition-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveAs(naming);
          }}
        >
          <input value={naming} onChange={(e) => setNaming(e.target.value)} placeholder={tx("검색 이름")} aria-label={tx("검색 이름")} autoFocus onKeyDown={(e) => e.key === "Escape" && setNaming(null)} />
          <button className="btn small primary" type="submit">
            {tx("저장")}
          </button>
        </form>
      )}
      {saved.length > 0 && (
        <div className="saved-searches" aria-label={tx("저장된 검색")}>
          {saved.map((s) => (
            <span key={s.name} className={`saved-chip${active?.name === s.name ? " on" : ""}`} title={searchLabel(s)}>
              <button className="saved-run" onClick={() => apply(s)}>
                {s.name}
              </button>
              <button
                className="saved-del"
                title={tx("저장된 검색 지우기")}
                aria-label={tx("{0} 지우기", s.name)}
                onClick={() => store(saved.filter((x) => x.name !== s.name))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="filters">
        <div className="filter-row">
          <select value={dateField} onChange={(e) => setDateField(e.target.value as DateFilter["field"])}>
            <option value="modified">{tx("수정일")}</option>
            <option value="created">{tx("생성일")}</option>
          </select>
          <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
            {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
              <option key={r} value={r}>
                {RANGE_LABEL[r]}
              </option>
            ))}
          </select>
          <button className="btn ghost small" onClick={() => setAdding((v) => !v)}>
            {tx("＋ 조건")}
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
            <button className="icon-btn" title={tx("조건 삭제")} onClick={() => setExtra(extra.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
      </div>

      {error && <p className="error pad small">{error}</p>}
      {result && (
        <p className="muted small pad result-summary">
          {tx("결과 {0}개 · {1}ms", result.total, result.took_ms)}
        </p>
      )}
      <ul className="results">
        {result?.hits.map((h) => (
          <li key={h.path} {...openProps((o) => openNote(h.path, h.line ?? undefined, undefined, o))} title={h.path}>
            <div className="r-title">{h.title}</div>
            {h.parts.length > 0 && (
              <div className="r-snippet">
                {h.parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
              </div>
            )}
            <div className="r-meta">
              {h.path.includes("/") ? h.path.slice(0, h.path.lastIndexOf("/")) : tx("맨 위 폴더")} ·{" "}
              {new Date(h.mtime).toLocaleDateString(dateLocale(), { month: "2-digit", day: "2-digit" })}
            </div>
          </li>
        ))}
      </ul>
      {result && result.total === 0 && <p className="muted small pad">{tx("결과 없음 · 조건을 줄여 보세요")}</p>}
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
      <input list="nv-prop-keys" placeholder={tx("속성")} value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
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
          <input list="nv-prop-values" placeholder={tx("값")} value={value} onChange={(e) => setValue(e.target.value)} />
          <datalist id="nv-prop-values">
            {values.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </>
      )}
      <button className="btn small primary" onClick={submit}>
        {tx("추가")}
      </button>
    </div>
  );
}
