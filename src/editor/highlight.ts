// Token colors for markdown and fenced code blocks (FR-EDT-06).
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const noteHighlight = HighlightStyle.define([
  // markdown
  { tag: t.heading, fontWeight: "700" },
  { tag: t.processingInstruction, color: "var(--muted)" }, // # * ` > marks shown on the cursor line
  { tag: t.quote, color: "var(--muted)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.contentSeparator, color: "var(--muted)" },
  // code
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "#b5520f" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#2f855a" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#7c3aed" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#2563eb" },
  { tag: [t.typeName, t.className, t.namespace], color: "#0e7490" },
  { tag: [t.definition(t.variableName), t.propertyName], color: "var(--text)" },
  { tag: t.invalid, color: "var(--danger)" },
]);
