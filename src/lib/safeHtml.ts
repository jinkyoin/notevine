import DOMPurify from "dompurify";
import { noteToHtml } from "./renderNote";
import { safeStyle } from "../editor/colors";

// Text/background colors (SCR-04) are the only styles kept; anything else, urls
// included, is dropped so the page can't load from the network.
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "style") return;
  const s = safeStyle(data.attrValue);
  if (s) data.attrValue = s;
  else data.keepAttr = false;
});

/** Sanitized HTML. Nothing in it may load from the network: `src` comes only from us. */
export function safeHtml(text: string): string {
  return DOMPurify.sanitize(noteToHtml(text), {
    // SVG can load from the network by its own links, and an image map's links would
    // move the app window. Mermaid and math are drawn after this, by their own libraries.
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "svg", "image", "feimage", "map", "area"],
    FORBID_ATTR: ["src", "srcset", "action", "formaction", "background", "poster", "usemap"],
  });
}
