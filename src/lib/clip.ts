// 웹 클리핑 (FR-ATT-03): 가져온 웹 페이지에서 본문만 골라 마크다운 노트로 만든다.
// 페이지의 스크립트는 실행하지 않는다(DOMParser는 문서를 만들기만 한다).
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

export interface Clip {
  title: string;
  /** Body as markdown. */
  markdown: string;
  site: string;
  byline: string;
}

const OPTIONS = { headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" } as const;
const turndown = new TurndownService(OPTIONS);
// Scripts, forms and frames go.
turndown.remove(["script", "style", "noscript", "iframe", "form", "button"]);

/** Converts one cell of a table that holds no other table. */
const cellTurndown = new TurndownService(OPTIONS);
cellTurndown.remove(["script", "style", "noscript", "iframe", "form", "button"]);

/** A cell's markdown on one line: lines joined with <br>, bars escaped. */
function cellText(cell: Element): string {
  return cellTurndown
    .turndown(cell.innerHTML)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("<br>")
    .replace(/\|/g, "\\|");
}

/** The table's rows as a grid; a merged cell (colspan/rowspan) leaves the other places empty. */
function tableGrid(table: HTMLTableElement): string[][] {
  const rows = [...table.rows];
  const grid: string[][] = [];
  rows.forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of [...row.cells]) {
      while (grid[r][c] !== undefined) c++;
      const span = Math.max(1, Math.min(cell.colSpan || 1, 50));
      const down = Math.max(1, Math.min(cell.rowSpan || 1, rows.length - r));
      for (let dr = 0; dr < down; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < span; dc++) grid[r + dr][c + dc] = dr === 0 && dc === 0 ? cellText(cell) : "";
      }
      c += span;
    }
  });
  return grid;
}

// Tables become markdown tables. Page layout is just its content: a table holding other tables
// (Naver Blog puts the whole post in one; the tables inside still become tables), and a
// one-column or one-row table (a notice box, a picture beside text).
turndown.addRule("table", {
  filter: "table",
  replacement(content, node) {
    if ((node as HTMLElement).querySelector("table")) return `\n\n${content}\n\n`;
    // Markdown tables need a header row: the first row is it, th or not.
    const grid = tableGrid(node as HTMLTableElement);
    const width = Math.max(0, ...grid.map((r) => r.length));
    if (width <= 1 || grid.length <= 1) return `\n\n${content}\n\n`;
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    const [first, ...rest] = grid;
    const sep = `| ${Array(width).fill("---").join(" | ")} |`;
    return `\n\n${[line(first), sep, ...rest.map(line)].join("\n")}\n\n`;
  },
});

/** The article in `html` (fetched from `url`) as a note body; null when there is no readable text. */
export function clipPage(html: string, url: string): Clip | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Relative links and images resolve against the page's own address.
  const base = doc.createElement("base");
  base.href = url;
  doc.head.prepend(base);
  for (const a of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) a.setAttribute("href", a.href);
  for (const img of doc.querySelectorAll<HTMLImageElement>("img")) {
    // A lazy image's src is only a placeholder until the page's script swaps it, which never runs here.
    const lazy = img.getAttribute("data-lazy-src") ?? img.getAttribute("data-src");
    if (lazy) img.setAttribute("src", lazy);
    if (img.hasAttribute("src")) img.setAttribute("src", img.src);
  }
  // Naver Blog: only the post, not the blog's notice list, profile and menus around it.
  const post = doc.querySelector(".se-main-container, #postViewArea");
  if (post?.textContent?.trim()) doc.body.replaceChildren(post);

  const article = new Readability(doc, { keepClasses: false }).parse();
  if (!article?.content || !article.textContent?.trim()) return null;
  const markdown = turndown
    .turndown(article.content)
    // Naver Blog's empty lines hold only a zero-width space.
    .replace(/^[​\s]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: (article.title || new URL(url).hostname).trim(),
    markdown,
    site: (article.siteName || new URL(url).hostname).trim(),
    byline: (article.byline ?? "").trim(),
  };
}

/**
 * The address of the frame a shell page shows its content in (Naver Blog does this).
 * Same host only: a page must not be able to send the app to another server or to this PC.
 */
function frameAddress(html: string, url: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const frames = doc.querySelectorAll("iframe[src], frame[src]");
  const frame = doc.querySelector("iframe#mainFrame[src], frame#mainFrame[src]") ?? (frames.length === 1 ? frames[0] : null);
  if (!frame) return null;
  try {
    const target = new URL(frame.getAttribute("src")!, url);
    return /^https?:$/.test(target.protocol) && target.hostname === new URL(url).hostname ? target.href : null;
  } catch {
    return null;
  }
}

/** The article of a fetched page, or of the one frame it shows the article in. */
export async function clipFetched(
  page: { url: string; html: string },
  fetchPage: (url: string) => Promise<{ url: string; html: string }>,
): Promise<Clip | null> {
  const clip = clipPage(page.html, page.url);
  if (clip) return clip;
  const frame = frameAddress(page.html, page.url);
  if (!frame) return null;
  const inner = await fetchPage(frame);
  return clipPage(inner.html, inner.url);
}

const MAX_IMAGES = 50;
const IMAGE_WORKERS = 6;
const LINK_TITLE = String.raw`(?:\s+"[^"]*")?`;
/** Code (left alone), a picture wrapped in a link, or a picture. */
const CODE_OR_IMAGE = new RegExp(
  "```[\\s\\S]*?```|`[^`\\n]*`" +
    String.raw`|\[!\[([^\]]*)\]\((https?:[^\s)]+)${LINK_TITLE}\)\]\([^)\s]*${LINK_TITLE}\)` +
    String.raw`|!\[([^\]]*)\]\((https?:[^\s)]+)${LINK_TITLE}\)`,
  "g",
);

/**
 * Saves the note's web pictures with `save` and points the note at the saved files, since
 * notes show no pictures from the web. One that can't be saved stays a web address.
 */
export async function saveClipImages(markdown: string, save: (url: string) => Promise<string>): Promise<{ markdown: string; saved: number; failed: number }> {
  const urls = [...new Set([...markdown.matchAll(CODE_OR_IMAGE)].map((m) => m[2] ?? m[4]).filter((u): u is string => !!u))];
  const queue = urls.slice(0, MAX_IMAGES);
  const files = new Map<string, string>();
  const work = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const file = await save(url).catch(() => null);
      if (file) files.set(url, file);
    }
  };
  await Promise.all(Array.from({ length: IMAGE_WORKERS }, work));
  const swapped = markdown.replace(CODE_OR_IMAGE, (all, wrappedAlt?: string, wrappedUrl?: string, alt?: string, url?: string) => {
    const file = files.get((wrappedUrl ?? url)!);
    if (!file) return all;
    const label = (wrappedAlt ?? alt ?? "").replace(/[|[]/g, " ").trim();
    // A number after the bar would read as the picture's width.
    return label && !/^\d+$/.test(label) ? `![[${file}|${label}]]` : `![[${file}]]`;
  });
  return { markdown: swapped, saved: files.size, failed: urls.length - files.size };
}

/** A file name from the page title: no characters Windows refuses, not too long. */
export function clipFileName(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return name || "웹 클립";
}

/** The note: properties (source, site, clipped date), the title and the article. */
export function clipNote(clip: Clip, url: string, today: string): string {
  const yaml = (s: string) => JSON.stringify(s);
  const props = [
    "---",
    "type: clip",
    `source: ${yaml(url)}`,
    `site: ${yaml(clip.site)}`,
    ...(clip.byline ? [`author: ${yaml(clip.byline)}`] : []),
    `created: ${today}`,
    "---",
  ];
  return `${props.join("\n")}\n\n# ${clip.title}\n\n> 원문: [${clip.site}](${url})\n\n${clip.markdown}\n`;
}

/** The clip as a section of the open note: its title, the source with the clipped date, the article. */
export function clipSection(clip: Clip, url: string, today: string): string {
  return `## ${clip.title}\n\n> 원문: [${clip.site}](${url}) · ${today} 클립\n\n${clip.markdown.trim()}`;
}

const NOTE_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;

/**
 * Puts a clipped section into `text` at `pos` (below the properties if `pos` is inside them),
 * with a blank line before and after it. Returns the new text and where the cursor goes (its end).
 */
export function insertClip(text: string, pos: number, section: string): { text: string; cursor: number } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = section.replace(/\r?\n/g, eol);
  const fm = NOTE_FRONTMATTER.exec(text)?.[0].length ?? 0;
  const at = Math.max(fm, Math.min(pos, text.length));
  // Text before the cursor, below the properties; the properties keep their own line end.
  const before = text.slice(fm, at).replace(/\s+$/, "");
  const after = text.slice(at).replace(/^\s+/, "");
  const head = before ? text.slice(0, fm) + before + eol + eol : fm ? text.slice(0, fm) + eol : "";
  const tail = after ? eol + eol + after : eol;
  const out = head + body + tail;
  return { text: out, cursor: head.length + body.length };
}
