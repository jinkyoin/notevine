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

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
// Tables stay readable as text; scripts, forms and frames go.
turndown.remove(["script", "style", "noscript", "iframe", "form", "button"]);

/** The article in `html` (fetched from `url`) as a note body; null when there is no readable text. */
export function clipPage(html: string, url: string): Clip | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Relative links and images resolve against the page's own address.
  const base = doc.createElement("base");
  base.href = url;
  doc.head.prepend(base);
  for (const a of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) a.setAttribute("href", a.href);
  for (const img of doc.querySelectorAll<HTMLImageElement>("img[src]")) img.setAttribute("src", img.src);

  const article = new Readability(doc, { keepClasses: false }).parse();
  if (!article?.content || !article.textContent?.trim()) return null;
  const markdown = turndown
    .turndown(article.content)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: (article.title || new URL(url).hostname).trim(),
    markdown,
    site: (article.siteName || new URL(url).hostname).trim(),
    byline: (article.byline ?? "").trim(),
  };
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
