// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { safeHtml } from "./safeHtml";

describe("safeHtml", () => {
  it.each([
    ['<svg width="1"><image href="https://evil.example/b.png"></image></svg>', "image"],
    ['<svg><image xlink:href="https://evil.example/b.png"></image></svg>', "xlink"],
    ['<svg><filter id="f"><feImage href="https://evil.example/b.png"></feImage></filter><rect filter="url(#f)"></rect></svg>', "feImage"],
    ['<svg><use href="https://evil.example/s.svg#a"></use></svg>', "use"],
  ])("keeps nothing that loads from the network: %s", (html) => {
    const out = safeHtml(html);
    expect(out).not.toContain("evil.example");
  });

  it("drops image maps, whose links would move the app window", () => {
    const out = safeHtml('<img data-embed="x.png" usemap="#m" width="9"><map name="m"><area shape="default" href="https://evil.example/x"></map>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("usemap");
    expect(out).not.toContain("<area");
  });

  it("still drops scripts, handlers and src", () => {
    const out = safeHtml('<img src="https://evil.example/a.png" onerror="x()"><script>x()</script>');
    expect(out).not.toMatch(/evil\.example|onerror|<script/);
  });

  it("keeps what notes use", () => {
    const out = safeHtml('**굵게** [[회의록]] <span style="color: red">빨강</span>');
    expect(out).toContain("<strong>굵게</strong>");
    expect(out).toContain('class="wikilink"');
    expect(out).toContain("color");
  });
});
