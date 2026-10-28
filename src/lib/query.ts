// 검색창 문법(SCR-05): `#태그`, `키:값`·`키=값`·`키!=값`, `"정확한 구"`, 나머지는 검색어.
import type { PropFilter, SearchQuery } from "../api";

export function parseQuery(input: string): SearchQuery {
  const q: SearchQuery = { text: [], tags: [], props: [] };
  const tokens = input.match(/"[^"]*"?|\S+/g) ?? [];
  for (const raw of tokens) {
    if (raw.startsWith('"')) {
      const phrase = raw.replace(/^"|"$/g, "").trim();
      if (phrase) q.text.push(phrase);
      continue;
    }
    if (raw.startsWith("#") && raw.length > 1) {
      q.tags.push(raw.slice(1));
      continue;
    }
    const m = /^([^:=!]+)(!=|=|:)(.*)$/.exec(raw);
    if (m && !/^https?$/i.test(m[1])) {
      const [, key, op, value] = m;
      const filter: PropFilter =
        op === "!="
          ? { key, op: "ne", value }
          : value === ""
            ? { key, op: "empty", value: null }
            : { key, op: "eq", value };
      q.props.push(filter);
      continue;
    }
    q.text.push(raw);
  }
  return q;
}

export function isEmptyQuery(q: SearchQuery): boolean {
  return !q.text.length && !q.tags.length && !q.props.length && !q.date;
}
