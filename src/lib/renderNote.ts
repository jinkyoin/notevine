// SCR-04 읽기 모드: 노트 마크다운을 서식이 적용된 HTML로 바꾼다.
// [[링크]]·![[그림]]·==강조==·#태그 같은 Notevine 문법을 더하고, 클릭 처리에 쓸 data-* 속성을 단다.
// 결과는 신뢰하지 않는 HTML이므로 화면에 넣기 전에 반드시 정화(DOMPurify)한다.
// 수식($…$, $$…$$)과 ```mermaid 블록은 원문만 data-* 속성에 담아 두고, 정화가 끝난 뒤 읽기 화면이 그린다.
import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { calloutHead } from "./callout";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function splitTarget(inner: string) {
  const bar = inner.indexOf("|");
  const head = bar < 0 ? inner : inner.slice(0, bar);
  const hash = head.indexOf("#");
  return {
    target: (hash < 0 ? head : head.slice(0, hash)).trim(),
    heading: hash < 0 ? null : head.slice(hash + 1).trim() || null,
    alias: bar < 0 ? null : inner.slice(bar + 1).trim(),
  };
}

const wiki: TokenizerAndRendererExtension = {
  name: "wiki",
  level: "inline",
  start: (src) => src.match(/!?\[\[/)?.index,
  tokenizer(src) {
    const m = /^(!?)\[\[([^[\]\n]+?)\]\]/.exec(src);
    if (!m) return undefined;
    const { target, heading, alias } = splitTarget(m[2]);
    // [[#제목]] points at a heading in the same note.
    if (!target && !heading) return undefined;
    return { type: "wiki", raw: m[0], embed: m[1] === "!", target, heading, alias };
  },
  renderer(t) {
    const { embed, target, heading, alias } = t as unknown as {
      embed: boolean;
      target: string;
      heading: string | null;
      alias: string | null;
    };
    if (embed && IMAGE.test(target)) {
      const width = alias && /^\d+$/.test(alias) ? ` width="${alias}"` : "";
      return `<img data-embed="${esc(target)}" alt="${esc(alias && !width ? alias : target)}"${width}>`;
    }
    const h = heading ? ` data-heading="${esc(heading)}"` : "";
    // Only the name shows; the folder is in the link, not in the text read.
    const name = target.slice(target.lastIndexOf("/") + 1);
    const label = alias || (heading ? (target ? `${name} › ${heading}` : heading) : name);
    const link = `<a href="#" class="wikilink" data-target="${esc(target)}"${h}>${esc(label)}</a>`;
    // ![[노트]] / ![[노트#제목]]: the read view puts the note's text under the link.
    // Other files (![[견적서.xlsx]]) stay links.
    const file = /\.[a-z0-9]{1,8}$/i.test(target) && !/\.md$/i.test(target);
    if (embed && !file) return `<span class="note-embed" data-note-embed="${esc(target)}"${h}>${link}</span>`;
    return link;
  },
};

const highlight: TokenizerAndRendererExtension = {
  name: "highlight",
  level: "inline",
  start: (src) => src.indexOf("=="),
  tokenizer(src) {
    const m = /^==(?=\S)([^\n]*?\S)==/.exec(src);
    if (!m) return undefined;
    return { type: "highlight", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(t) {
    return `<mark>${this.parser.parseInline((t as Tokens.Generic).tokens!)}</mark>`;
  },
};

const tag: TokenizerAndRendererExtension = {
  name: "tag",
  level: "inline",
  // Only a "#" at the start or after whitespace begins a tag ("a#b" stays text).
  start(src) {
    const m = /(^|\s)#[^\s#]/.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = /^#([^\s#.,;:!?()[\]{}<>"'`]+)/.exec(src);
    if (!m || /^\d+$/.test(m[1])) return undefined;
    return { type: "tag", raw: m[0], name: m[1] };
  },
  renderer(t) {
    const name = (t as unknown as { name: string }).name;
    return `<a href="#" class="tag" data-tag="${esc(name)}">#${esc(name)}</a>`;
  },
};

/** Formula source for data-tex, percent-encoded: DOMPurify drops attributes holding "-->" or "]>". */
const texAttr = (tex: string) => encodeURIComponent(tex);

/** `$$ … $$` on lines of their own: a display formula. */
const mathBlock: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start: (src) => src.match(/^ {0,3}\$\$/m)?.index,
  tokenizer(src) {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
    if (!m || !m[1].trim()) return undefined;
    return { type: "mathBlock", raw: m[0], tex: m[1].trim() };
  },
  renderer(t) {
    const tex = (t as unknown as { tex: string }).tex;
    return `<div class="math math-block" data-tex="${texAttr(tex)}">${esc(`$$${tex}$$`)}</div>\n`;
  },
};

/**
 * `$x^2$` inside a line. Like pandoc, the opening `$` is followed and the closing one
 * preceded by a non-space, and the closing one is not followed by a digit, so
 * "$5 and $10" stays text. `\$` is a plain dollar sign.
 */
const mathInline: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start(src) {
    const m = /(?<!\\)\$/.exec(src);
    return m?.index;
  },
  tokenizer(src) {
    const m = /^\$\$(?!\s)([^\n]*?\S)\$\$|^\$(?![\s$])((?:\\.|[^\\$\n])*?[^\s\\])\$(?!\d)/.exec(src);
    if (!m) return undefined;
    return { type: "mathInline", raw: m[0], tex: m[1] ?? m[2], display: m[1] !== undefined };
  },
  renderer(t) {
    const { tex, display } = t as unknown as { tex: string; display: boolean };
    const cls = display ? "math math-block" : "math";
    return `<span class="${cls}" data-tex="${texAttr(tex)}">${esc(display ? `$$${tex}$$` : `$${tex}$`)}</span>`;
  },
};

/** ` ^id` ending a line marks a block ([[노트#^id]]): hidden, kept as a jump target. */
const blockId: TokenizerAndRendererExtension = {
  name: "blockId",
  level: "inline",
  start(src) {
    return /[ \t]\^[A-Za-z0-9-]+[ \t]*(?:\n|$)/.exec(src)?.index;
  },
  tokenizer(src) {
    const m = /^[ \t]\^([A-Za-z0-9-]+)[ \t]*(?=\n|$)/.exec(src);
    return m ? { type: "blockId", raw: m[0], id: m[1].toLowerCase() } : undefined;
  },
  renderer(t) {
    return `<span class="block-id" data-block="${esc((t as unknown as { id: string }).id)}"></span>`;
  },
};

/**
 * A line starting with a Korean-style date ("2026. 06. 22 ~ …") is text, not a list
 * numbered from 2026 whose marker juts out to the left.
 */
const koDate: TokenizerAndRendererExtension = {
  name: "koDate",
  level: "block",
  tokenizer(src) {
    const m = /^ {0,3}\d{4}\. {0,2}\d{1,2}\. {0,2}\d{1,2}\b[^\n]*(?:\n|$)/.exec(src);
    if (!m) return undefined;
    const text = m[0].trim();
    return { type: "paragraph", raw: m[0], text, tokens: this.lexer.inline(text) };
  },
};

function makeMarked() {
  const m = new Marked({ gfm: true, breaks: true });
  m.use({
    extensions: [koDate, mathBlock, wiki, highlight, tag, mathInline, blockId],
    renderer: {
      // Clickable task boxes: data-task is the n-th task in the note (see toggleTask).
      // ```mermaid blocks show as code until drawn. The source stays in the <code> text, not an
      // attribute: DOMPurify drops attributes containing "-->", and every arrow has one.
      code({ text, lang }) {
        if ((lang ?? "").trim().toLowerCase() !== "mermaid") return false;
        return `<div class="mermaid-block" data-mermaid=""><pre><code>${esc(text)}</code></pre></div>\n`;
      },
      // "> [!중요] 제목": a colored box (see callout.ts) instead of a plain quote.
      blockquote({ tokens }) {
        const first = tokens[0];
        if (first?.type !== "paragraph") return false;
        const line = (first as Tokens.Paragraph).text.split("\n")[0];
        const head = calloutHead(line);
        if (!head) return false;
        const rest = (first as Tokens.Paragraph).text.slice(line.length + 1);
        const body = this.parser.parse([...(rest.trim() ? m.lexer(rest) : []), ...tokens.slice(1)]);
        const title = head.title ? (m.parseInline(head.title, { async: false }) as string) : esc(head.type.label);
        const { kind, icon } = head.type;
        return (
          `<div class="callout callout-${kind}"><div class="callout-title"><span class="callout-icon">${esc(icon)}</span>` +
          `${title}</div>${body.trim() ? `<div class="callout-body">${body}</div>` : ""}</div>\n`
        );
      },
      checkbox({ checked }) {
        return `<input type="checkbox" class="task"${checked ? " checked" : ""}> `;
      },
      image({ href, title, text }) {
        const t = title ? ` title="${esc(title)}"` : "";
        // Web images are not fetched (no network use without asking): show a link instead.
        if (/^https?:/i.test(href)) return `<a href="#" class="external" data-url="${esc(href)}"${t}>[그림] ${esc(text || href)}</a>`;
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return esc(text);
        return `<img data-embed="${esc(href)}" data-md="1" alt="${esc(text)}"${t}>`;
      },
      link({ href, title, tokens }) {
        const t = title ? ` title="${esc(title)}"` : "";
        const body = this.parser.parseInline(tokens);
        if (/^(https?:|mailto:)/i.test(href)) return `<a href="#" class="external" data-url="${esc(href)}"${t}>${body}</a>`;
        return `<a href="#" class="wikilink" data-dest="${esc(href)}"${t}>${body}</a>`;
      },
    },
  });
  return m;
}

const marked = makeMarked();

/** Note text → HTML (not yet sanitized). Properties (frontmatter) are left to the properties panel. */
export function noteToHtml(text: string): string {
  return marked.parse(text.replace(FRONTMATTER, ""), { async: false }) as string;
}

/**
 * Flips the `index`-th task box ("- [ ]" ↔ "- [x]") in the note text, counting
 * the same way the rendered view does (not inside code fences or frontmatter).
 * Null when there is no such task.
 */
export function toggleTask(text: string, index: number): string | null {
  const fm = FRONTMATTER.exec(text);
  const start = fm ? fm[0].length : 0;
  const lines = text.slice(start).split("\n");
  let fence: string | null = null;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(```|~~~)/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)]) \[)([ xX])\]/.exec(lines[i]);
    if (!m) continue;
    if (n++ === index) {
      lines[i] = m[1] + (m[2] === " " ? "x" : " ") + lines[i].slice(m[1].length + 1);
      return text.slice(0, start) + lines.join("\n");
    }
  }
  return null;
}
