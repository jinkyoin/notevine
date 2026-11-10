// AI에 보낼 파일의 글자 (FR-AI-03). PDF는 화면의 PDF 엔진(pdfjs)으로, 나머지는 앱(filetext.rs)이 뽑는다.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Stop reading a PDF's pages once this much text is in hand: more is cut before sending anyway. */
const PDF_TEXT_MAX = 60_000;

async function pdfText(path: string): Promise<string> {
  const doc = await pdfjs.getDocument({
    url: convertFileSrc(await api.attachmentPath(path)),
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    isEvalSupported: false,
  }).promise;
  try {
    const pages: string[] = [];
    let size = 0;
    for (let i = 1; i <= doc.numPages && size < PDF_TEXT_MAX; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      text = text.replace(/[ \t]+\n/g, "\n").trim();
      if (text) {
        pages.push(`[p.${i}]\n${text}`);
        size += text.length;
      }
    }
    return pages.join("\n\n");
  } finally {
    void doc.destroy();
  }
}

/** The text of a vault file to send to AI ("" when it has none, like a scanned PDF). */
export function fileText(path: string): Promise<string> {
  return /\.pdf$/i.test(path) ? pdfText(path) : api.aiFileText(path);
}
