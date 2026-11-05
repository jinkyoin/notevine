// AI 노트 작업: AI는 파일을 직접 건드리지 않고 정해진 형식으로 변경을 "제안"만 한다.
// 여기서 그 제안을 읽고(parseEdits), 지금 노트에 적용했을 때의 결과를 계산하고(planEdit),
// 바뀌는 줄을 비교해(lineDiff) 사용자가 확인한 것만 앱이 저장한다.
import { tx } from "../i18n";

export type Change = { find: string; replace: string };

export type Edit =
  | { kind: "create"; path: string; content: string }
  | { kind: "append"; path: string; content: string }
  | { kind: "edit"; path: string; changes: Change[] };

export const EDIT_KIND_LABEL: Record<Edit["kind"], string> = { create: tx("새 노트"), append: tx("덧붙이기"), edit: tx("고치기") };

/** How the AI refers to the open note, whose real path it isn't told unless the note was sent. */
export const OPEN_NOTE_ALIAS = "열린노트.md";

export interface EditSystemOptions {
  /** Offered to the AI for placing new notes; empty when the folder names shouldn't go along. */
  folders: string[];
  newNoteDir: string;
  today: string;
  /** What the wording of the request asks for (`writeIntent`). */
  intent?: "new" | "open" | null;
  /** Title of the open note that the writing goes to. */
  target?: string | null;
  /** Path of the sent template to follow. */
  template?: string | null;
}

/** When to propose changes instead of answering, for this request. */
function routing(o: EditSystemOptions): string[] {
  if (o.intent === "new") return ["사용자가 새 노트를 요청했다. 결과를 CREATE 블록으로 제안한다."];
  if (o.intent === "open" && o.target) {
    return [
      `사용자가 노트에 쓰기를 요청했고 지금 열린 노트의 제목은 "${o.target}"이다. 다른 노트를 가리키지 않았으면 결과를 답으로 쓰지 말고 === APPEND: ${OPEN_NOTE_ALIAS} === 블록으로 제안한다. 열린 노트의 글을 고치라는 요청이면 === EDIT: ${OPEN_NOTE_ALIAS} === 블록을 쓴다.`,
    ];
  }
  if (o.intent === "open") {
    return ["사용자가 글을 쓰라고 요청했지만 열린 노트가 없다. <참고 노트>의 특정 노트를 고치라는 요청이 아니면 블록을 쓰지 말고 결과 글 자체를 답으로 쓴다. 사용자가 답을 새 노트로 저장하거나 복사한다."];
  }
  return ["사용자가 노트를 만들거나 고치라고 분명히 요청하지 않았으면 블록을 쓰지 말고 답만 쓴다."];
}

/** What the AI is told about proposing changes; `folders` helps it put new notes in the right place. */
export function editSystem(opts: EditSystemOptions): string {
  const folders = opts.folders.slice(0, 60).join(", ");
  return [
    "노트를 만들거나 고치라는 요청이면 아래 형식으로 변경을 제안한다. 너는 파일을 직접 바꿀 수 없다. 사용자가 하나씩 확인한 뒤 앱이 적용한다.",
    ...routing(opts),
    ...(opts.template
      ? [
          `<참고 노트>의 path="${opts.template}" 노트는 템플릿이다. 결과는 이 템플릿의 제목 구조·항목 순서·속성을 그대로 따르고, 안내 문구와 자리표시자({{...}})는 실제 내용으로 채운다. 확인하지 못한 항목은 '확인 필요'로 둔다. 템플릿 노트 자체는 고치지 않는다. 있는 노트에 덧붙일 때는 맨 위의 --- 속성 부분을 빼고 쓴다.`,
        ]
      : []),
    "",
    "형식 (블록 여러 개 가능):",
    "=== CREATE: 폴더/이름.md ===",
    "(새 노트의 전체 내용)",
    "=== END ===",
    "",
    "=== APPEND: 경로.md ===",
    "(노트 끝에 덧붙일 내용)",
    "=== END ===",
    "",
    "=== EDIT: 경로.md ===",
    "--- FIND ---",
    "(노트에 있는 원래 글. 한 글자도 바꾸지 말고 그대로 옮기되, 그 노트에서 한 곳만 가리킬 만큼만 짧게)",
    "--- REPLACE ---",
    "(그 자리에 들어갈 새 글)",
    "=== END ===",
    "",
    "규칙:",
    `- 고치거나 덧붙일 수 있는 노트는 <참고 노트>에 있는 노트(path 그대로)${opts.target ? `와 ${OPEN_NOTE_ALIAS}` : ""}뿐이다. 그 밖의 노트는 CREATE로 새로 만들 수만 있다.`,
    "- EDIT 블록 하나에 --- FIND --- / --- REPLACE --- 쌍을 여러 번 넣을 수 있다. 노트 전체를 다시 쓰지 말고 바뀌는 부분만 FIND/REPLACE로 쓴다.",
    "- 노트를 지우거나 이름을 바꾸는 제안은 하지 않는다.",
    `- 경로는 노트 폴더 기준 상대 경로이고 .md로 끝난다. 새 노트는 따로 말이 없으면 ${opts.newNoteDir ? `"${opts.newNoteDir}" 폴더` : "노트 폴더 맨 위"}에 만든다.${folders ? ` 있는 폴더: ${folders}` : ""}`,
    "- 다른 노트를 가리킬 때는 [[노트 이름]] 링크를 쓴다.",
    "- 블록을 쓸 때 블록 밖에는 무엇을 왜 바꾸는지 한두 문장만 쓴다.",
    `- 오늘 날짜: ${opts.today}`,
  ].join("\n");
}

const OPEN = /^\s*===\s*(CREATE|APPEND|EDIT)\s*:\s*(.+?)\s*===\s*$/i;
const END = /^\s*===\s*END\s*===\s*$/i;
const FIND = /^\s*---\s*FIND\s*---\s*$/i;
const REPLACE = /^\s*---\s*REPLACE\s*---\s*$/i;

/** A block's text without a code fence the model may have wrapped it in. */
function unfence(lines: string[]): string {
  let l = lines;
  if (l.length >= 2 && /^\s*```\w*\s*$/.test(l[0]) && /^\s*```\s*$/.test(l[l.length - 1])) l = l.slice(1, -1);
  return l.join("\n");
}

/** Reads the AI's answer: its explanation (text outside blocks) and the proposed edits. */
export function parseEdits(text: string): { message: string; edits: Edit[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const message: string[] = [];
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m) {
      // Fences around the whole answer are not part of the explanation.
      if (!/^\s*```\w*\s*$/.test(lines[i])) message.push(lines[i]);
      continue;
    }
    const kind = m[1].toLowerCase() as Edit["kind"];
    const path = m[2].replace(/^["'`]|["'`]$/g, "").trim();
    const body: string[] = [];
    for (i++; i < lines.length && !END.test(lines[i]) && !OPEN.test(lines[i]); i++) body.push(lines[i]);
    if (i < lines.length && OPEN.test(lines[i])) i--; // a block without END: the next block starts here
    if (kind !== "edit") {
      edits.push({ kind, path, content: unfence(body) });
      continue;
    }
    const changes: Change[] = [];
    let find: string[] | null = null;
    let repl: string[] | null = null;
    const flush = () => {
      if (find && repl) changes.push({ find: unfence(find), replace: unfence(repl) });
      find = repl = null;
    };
    for (const l of body) {
      if (FIND.test(l)) {
        flush();
        find = [];
      } else if (REPLACE.test(l) && find) repl = [];
      else if (repl) repl.push(l);
      else if (find) find.push(l);
    }
    flush();
    edits.push({ kind, path, changes });
  }
  return { message: message.join("\n").trim(), edits };
}

/** A vault-relative note path, or null when it would leave the vault or isn't a note. */
export function cleanPath(p: string): string | null {
  const parts = p.replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s && s !== ".");
  if (!parts.length || parts.some((s) => s === ".." || s.startsWith(".") || /[<>:"|?*]/.test(s))) return null;
  let path = parts.join("/");
  if (!/\.md$/i.test(path)) path += ".md";
  return path.normalize("NFC");
}

/** Where `find` is in `text`: exactly, else ignoring differences in spaces; null unless exactly one place. */
export function locate(text: string, find: string): { from: number; to: number } | "missing" | "many" {
  if (!find.trim()) return "missing";
  const at = text.indexOf(find);
  if (at >= 0) return text.indexOf(find, at + 1) >= 0 ? "many" : { from: at, to: at + find.length };
  const loose = new RegExp(
    find
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
    "g",
  );
  const hits = [...text.matchAll(loose)];
  if (hits.length === 1) return { from: hits[0].index!, to: hits[0].index! + hits[0][0].length };
  return hits.length ? "many" : "missing";
}

/** `text` with every change applied, or why it can't be. */
export function applyChanges(text: string, changes: Change[]): { text: string } | { error: string } {
  let out = text.replace(/\r\n/g, "\n");
  for (const [i, c] of changes.entries()) {
    const hit = locate(out, c.find.replace(/\r\n/g, "\n"));
    const n = changes.length > 1 ? tx(" ({0}번째)", i + 1) : "";
    if (hit === "missing") return { error: tx("바꿀 원래 글을 노트에서 찾지 못했습니다{0}", n) };
    if (hit === "many") return { error: tx("바꿀 원래 글이 노트에 여러 군데 있어 어디인지 모릅니다{0}", n) };
    out = out.slice(0, hit.from) + c.replace + out.slice(hit.to);
  }
  return { text: out };
}

/** Adds `content` at the end of `text`, with a blank line between. */
export function appendText(text: string, content: string): string {
  const body = text.replace(/\s*$/, "");
  return (body ? body + "\n\n" : "") + content.trim() + "\n";
}

export interface PlanContext {
  /** Notes sent to the AI with this request: the only ones it may change. */
  sent: Set<string>;
  /** Existing note paths (case-insensitive check). */
  exists: (path: string) => boolean;
  /** Current text of a note. */
  read: (path: string) => Promise<string>;
}

export interface Planned {
  edit: Edit;
  /** Cleaned path the edit goes to. */
  path: string;
  before: string;
  after: string;
  error: string | null;
}

/** What one proposal would do to the vault as it is now. */
export async function planEdit(edit: Edit, ctx: PlanContext): Promise<Planned> {
  const path = cleanPath(edit.path);
  const base = { edit, path: path ?? edit.path, before: "", after: "" };
  if (!path) return { ...base, error: tx("쓸 수 없는 경로입니다") };
  if (edit.kind === "create") {
    if (ctx.exists(path)) return { ...base, error: tx("같은 이름의 노트가 이미 있습니다") };
    const content = edit.content.trim() ? edit.content.replace(/\s*$/, "\n") : "";
    return { ...base, after: content, error: content ? null : tx("내용이 비어 있습니다") };
  }
  if (!ctx.exists(path)) return { ...base, error: tx("없는 노트입니다") };
  if (!ctx.sent.has(path)) return { ...base, error: tx("AI에 보내지 않은 노트라 고칠 수 없습니다") };
  let before: string;
  try {
    before = await ctx.read(path);
  } catch {
    return { ...base, error: tx("노트를 읽지 못했습니다") };
  }
  if (edit.kind === "append") {
    if (!edit.content.trim()) return { ...base, before, after: before, error: tx("덧붙일 내용이 비어 있습니다") };
    return { ...base, before, after: appendText(before, edit.content), error: null };
  }
  if (!edit.changes.length) return { ...base, before, after: before, error: tx("바꿀 내용이 없습니다") };
  const r = applyChanges(before, edit.changes);
  if ("error" in r) return { ...base, before, after: before, error: r.error };
  if (r.text === before.replace(/\r\n/g, "\n")) return { ...base, before, after: r.text, error: tx("바뀌는 내용이 없습니다") };
  return { ...base, before, after: r.text, error: null };
}

export type DiffRow = { kind: "same" | "add" | "del"; text: string };

/** Line diff of two texts (common start and end first, then LCS of the middle). */
export function lineDiff(a: string, b: string): DiffRow[] {
  const x = a ? a.replace(/\n$/, "").split("\n") : [];
  const y = b ? b.replace(/\n$/, "").split("\n") : [];
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xm = x.slice(s, x.length - e);
  const ym = y.slice(s, y.length - e);
  const mid: DiffRow[] = [];
  if (xm.length * ym.length > 4_000_000) {
    xm.forEach((t) => mid.push({ kind: "del", text: t }));
    ym.forEach((t) => mid.push({ kind: "add", text: t }));
  } else {
    // LCS table from the end, then walk forward.
    const n = xm.length;
    const m = ym.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xm[i] === ym[j]) {
        mid.push({ kind: "same", text: xm[i++] });
        j++;
      } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) mid.push({ kind: "del", text: xm[i++] });
      else mid.push({ kind: "add", text: ym[j++] });
    }
  }
  return [...x.slice(0, s).map((t) => ({ kind: "same" as const, text: t })), ...mid, ...x.slice(x.length - e).map((t) => ({ kind: "same" as const, text: t }))];
}

/** Rows to show: changes with `context` lines around them; long unchanged runs become one "…" row (null). */
export function diffHunks(rows: DiffRow[], context = 2): (DiffRow | { skip: number })[] {
  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffRow | { skip: number })[] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skipped) out.push({ skip: skipped });
      skipped = 0;
      out.push(r);
    } else skipped++;
  });
  if (skipped) out.push({ skip: skipped });
  return out;
}
