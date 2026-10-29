// 템플릿 삽입: 열린 노트의 커서 위치에 템플릿 본문을 넣고, 템플릿 속성 중 노트에 없는 것만 frontmatter에 더한다.
// 노트에 이미 있는 속성 값은 바꾸지 않는다.
import { isMap, isScalar, parseDocument } from "yaml";
import { splitFrontmatter } from "../lib/frontmatter";

const keyOf = (k: unknown) => (isScalar(k) ? String(k.value) : String(k));

/** Note frontmatter with the template's missing properties added; null when nothing to add or it can't be merged. */
function mergeProps(text: string, tplYaml: string): string | null {
  const tpl = parseDocument(tplYaml);
  if (tpl.errors.length || !isMap(tpl.contents)) return null;
  const { yaml, bodyStart, open } = splitFrontmatter(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (yaml === null) {
    const block = `---${eol}${tplYaml.replace(/\r?\n/g, eol)}---${eol}`;
    return block + (text && !text.startsWith(eol) ? eol : "") + text;
  }
  const doc = parseDocument(yaml);
  // Broken YAML in the note: leave it alone rather than clobber it.
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) return null;
  // An empty block ("---\n---") simply takes the template's properties.
  if (doc.contents === null) return `${text.slice(0, open)}${tplYaml.replace(/\r?\n/g, eol)}---${eol}${text.slice(bodyStart)}`;
  const map = doc.contents;
  const have = new Set(map.items.map((i) => keyOf(i.key)));
  const added = tpl.contents.items.filter((i) => !have.has(keyOf(i.key)));
  if (added.length === 0) return null;
  map.items.push(...added);
  let out = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n/g, eol);
  if (!out.endsWith(eol)) out += eol;
  return `${text.slice(0, open)}${out}---${eol}${text.slice(bodyStart)}`;
}

/**
 * Inserts a rendered template into `text` at `pos`: its body on lines of its own
 * (below the properties if `pos` is inside them), its properties merged in.
 * Returns the new text and where the cursor goes (end of the inserted body).
 */
export function insertTemplate(text: string, pos: number, template: string): { text: string; cursor: number } {
  const tpl = splitFrontmatter(template);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = template
    .slice(tpl.bodyStart)
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .trimEnd()
    .replace(/\r?\n/g, eol);

  let out = text;
  let at = Math.max(splitFrontmatter(text).bodyStart, Math.min(pos, text.length));
  if (tpl.yaml !== null) {
    const merged = mergeProps(text, tpl.yaml);
    if (merged !== null) {
      // Only the frontmatter changed, so the body keeps its offset from the end.
      at = merged.length - (text.length - at);
      out = merged;
    }
  }
  if (!body) return { text: out, cursor: at };

  const before = out.slice(0, at);
  const after = out.slice(at);
  const lead = before && !before.endsWith("\n") ? eol : "";
  const trail = after && !after.startsWith("\n") && !after.startsWith("\r\n") ? eol : "";
  const insert = lead + body + trail;
  return { text: before + insert + after, cursor: at + lead.length + body.length };
}
