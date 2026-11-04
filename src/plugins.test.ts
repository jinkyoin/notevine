// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanPanelHtml } from "./plugins";

describe("plugins", () => {
  it("keeps panel markup plain: nothing runs, links or loads", () => {
    const html = cleanPanelHtml(
      `<p onclick="x()">글 <b>굵게</b></p><script>alert(1)</script><img src="https://evil/x.png"><a href="https://evil">링크</a>` +
        `<button data-action="go" data-arg="1" style="background:url(https://evil)">가기</button><input name="q" value="v"><iframe src="x"></iframe>`,
    );
    expect(html).toBe(`<p>글 <b>굵게</b></p>링크<button data-action="go" data-arg="1">가기</button><input name="q" value="v">`);
  });
});
