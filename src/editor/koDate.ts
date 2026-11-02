// 편집 모드: "2026. 06. 22 ~ …"처럼 한국식 날짜로 시작하는 줄은 2026번부터 시작하는 번호 목록이 아니라 글이다.
// (읽기 모드는 renderNote.ts의 koDate가 같은 일을 한다.)
import type { MarkdownConfig } from "@lezer/markdown";

/** Same rule as the reading view's: a year, month and day, each followed by a dot. */
export const KO_DATE = /^\d{4}\. {0,2}\d{1,2}\. {0,2}\d{1,2}\b/;

export const koDate: MarkdownConfig = {
  parseBlock: [
    {
      name: "KoDate",
      before: "OrderedList",
      parse(cx, line) {
        if (line.indent > 3 || !KO_DATE.test(line.text.slice(line.pos))) return false;
        const from = cx.lineStart + line.pos;
        const text = line.text.slice(line.pos).trimEnd();
        cx.addElement(cx.elt("Paragraph", from, from + text.length, cx.parser.parseInline(text, from)));
        cx.nextLine();
        return true;
      },
    },
  ],
};
