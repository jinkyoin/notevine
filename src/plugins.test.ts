// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanPanelHtml, grantCovers } from "./plugins";
import type { PluginInfo } from "./api";

const info = (permissions: PluginInfo["permissions"]): PluginInfo => ({ id: "x", name: "x", version: "", description: "", author: "", permissions, error: null });

describe("plugins", () => {
  it("runs only with every permission it asks for granted", () => {
    expect(grantCovers(info(["read"]), undefined)).toBe(false);
    expect(grantCovers(info([]), [])).toBe(true);
    expect(grantCovers(info(["read", "write"]), ["read"])).toBe(false);
    expect(grantCovers(info(["read"]), ["read", "write"])).toBe(true);
  });

  it("keeps panel markup plain: nothing runs, links or loads", () => {
    const html = cleanPanelHtml(
      `<p onclick="x()">글 <b>굵게</b></p><script>alert(1)</script><img src="https://evil/x.png"><a href="https://evil">링크</a>` +
        `<button data-action="go" data-arg="1" style="background:url(https://evil)">가기</button><input name="q" value="v"><iframe src="x"></iframe>`,
    );
    expect(html).toBe(`<p>글 <b>굵게</b></p>링크<button data-action="go" data-arg="1">가기</button><input name="q" value="v">`);
  });
});
