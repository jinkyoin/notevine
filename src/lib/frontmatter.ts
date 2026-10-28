// 노트 frontmatter(YAML) 읽기·고치기. 속성 패널(SCR-08)이 편집기 텍스트를 직접 고칠 때 쓴다.
// 주석·순서·따옴표 스타일은 yaml Document API로 최대한 보존한다.
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

export type PropType = "text" | "number" | "bool" | "date" | "url" | "list";

export interface Prop {
  key: string;
  type: PropType;
  value: string | number | boolean | string[];
}

export interface Frontmatter {
  /** Raw YAML between the delimiters, or null when the note has none. */
  yaml: string | null;
  /** Character offset where the body starts (0 when there is no frontmatter). */
  bodyStart: number;
  props: Prop[];
  error: string | null;
}

const OPEN = /^﻿?---[ \t]*\r?\n/;

export function splitFrontmatter(text: string): { yaml: string | null; bodyStart: number; open: number } {
  const open = OPEN.exec(text);
  if (!open) return { yaml: null, bodyStart: 0, open: 0 };
  const close = /^(---|\.\.\.)[ \t]*(\r?\n|$)/m;
  const rest = text.slice(open[0].length);
  const m = close.exec(rest);
  if (!m) return { yaml: null, bodyStart: 0, open: 0 };
  return {
    yaml: rest.slice(0, m.index),
    bodyStart: open[0].length + m.index + m[0].length,
    open: open[0].length,
  };
}

export function typeOf(value: unknown): PropType {
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  const s = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}([T ]\d.*)?$/.test(s)) return "date";
  if (/^https?:\/\//i.test(s)) return "url";
  return "text";
}

function toProps(doc: Document): Prop[] {
  const contents = doc.contents;
  if (!isMap(contents)) return [];
  const props: Prop[] = [];
  for (const item of contents.items) {
    const key = isScalar(item.key) ? String(item.key.value) : String(item.key);
    const v = item.value;
    let value: Prop["value"];
    if (isSeq(v)) value = v.items.map((x) => (isScalar(x) ? String(x.value ?? "") : String(x)));
    else if (isScalar(v)) {
      const raw = v.value;
      value = typeof raw === "number" || typeof raw === "boolean" ? raw : String(raw ?? "");
      // YAML parses 2026-10-28 as a string with the core schema; keep it as text.
    } else value = v == null ? "" : JSON.stringify((v as unknown as { toJSON(): unknown }).toJSON());
    props.push({ key, type: typeOf(value), value });
  }
  return props;
}

export function readFrontmatter(text: string): Frontmatter {
  const { yaml, bodyStart } = splitFrontmatter(text);
  if (yaml === null) return { yaml: null, bodyStart: 0, props: [], error: null };
  const doc = parseDocument(yaml);
  if (doc.errors.length) return { yaml, bodyStart, props: [], error: doc.errors[0].message.split("\n")[0] };
  if (doc.contents !== null && !isMap(doc.contents)) {
    return { yaml, bodyStart, props: [], error: "속성은 '이름: 값' 형식이어야 합니다" };
  }
  return { yaml, bodyStart, props: toProps(doc), error: null };
}

/**
 * Returns `text` with property `key` set to `value` (or removed when `value` is undefined).
 * Creates the frontmatter block when the note has none. Returns null when the
 * existing YAML can't be parsed, so the caller doesn't clobber it.
 */
export function setProperty(text: string, key: string, value: Prop["value"] | undefined): string | null {
  const { yaml, bodyStart, open } = splitFrontmatter(text);
  const doc = parseDocument(yaml ?? "");
  if (doc.errors.length) return null;
  if (doc.contents !== null && !isMap(doc.contents)) return null;
  if (value === undefined) doc.delete(key);
  else {
    const node = doc.createNode(value);
    if (isSeq(node)) node.flow = true; // tags: [a, b] stays on one line
    doc.set(key, node);
  }
  const map = doc.contents;
  const empty = !isMap(map) || map.items.length === 0;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let body = yaml === null ? text : text.slice(bodyStart);
  if (empty) {
    // Removing the last property removes the block.
    return yaml === null ? text : body;
  }
  let out = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n/g, eol);
  if (!out.endsWith(eol)) out += eol;
  const head = yaml === null ? `---${eol}` : text.slice(0, open);
  if (yaml === null && body && !body.startsWith(eol)) body = eol + body;
  return `${head}${out}---${eol}${body}`;
}

/** Renames a property, keeping its value and position. */
export function renameProperty(text: string, from: string, to: string): string | null {
  const { yaml, bodyStart, open } = splitFrontmatter(text);
  if (yaml === null || from === to) return text;
  const doc = parseDocument(yaml);
  if (doc.errors.length || !isMap(doc.contents)) return null;
  const item = doc.contents.items.find((i) => (isScalar(i.key) ? String(i.key.value) : String(i.key)) === from);
  if (!item) return text;
  (item as { key: unknown }).key = doc.createNode(to);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n/g, eol);
  if (!out.endsWith(eol)) out += eol;
  return `${text.slice(0, open)}${out}---${eol}${text.slice(bodyStart)}`;
}
