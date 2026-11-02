// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clipFileName, clipNote, clipPage } from "./clip";

const PAGE = `<!doctype html><html><head><title>Tauri 2 자동 업데이트 정리 | 개발 블로그</title>
<meta property="og:site_name" content="개발 블로그"></head><body>
<nav><a href="/">홈</a> <a href="/about">소개</a></nav>
<script>alert("x")</script>
<article>
<h1>Tauri 2 자동 업데이트 정리</h1>
<p>업데이트 서버 없이도 <strong>GitHub Releases</strong>로 배포할 수 있다. 서명 키를 만들고 설정 파일에 공개 키를 넣는다.
자세한 내용은 <a href="/docs/updater">공식 문서</a>를 본다. 이 문단은 본문으로 뽑히도록 충분히 길게 쓴다.
업데이트 확인은 앱이 켜질 때 한 번, 그리고 사용자가 메뉴에서 고를 때 한다.</p>
<h2>설정</h2>
<ul><li>서명 키 만들기</li><li>공개 키 넣기</li></ul>
<pre><code>npm run tauri signer generate</code></pre>
<p><img src="img/flow.png" alt="흐름도"></p>
</article>
<footer>© 2026</footer></body></html>`;

describe("clipPage", () => {
  it("keeps the article as markdown with absolute links, without menus or scripts", () => {
    const clip = clipPage(PAGE, "https://blog.example.com/posts/tauri-update")!;
    expect(clip.site).toBe("개발 블로그");
    expect(clip.title).toContain("Tauri 2 자동 업데이트 정리");
    expect(clip.markdown).toContain("**GitHub Releases**");
    expect(clip.markdown).toContain("[공식 문서](https://blog.example.com/docs/updater)");
    expect(clip.markdown).toContain("## 설정");
    expect(clip.markdown).toMatch(/-\s+서명 키 만들기/);
    expect(clip.markdown).toContain("```\nnpm run tauri signer generate\n```");
    expect(clip.markdown).toContain("![흐름도](https://blog.example.com/posts/img/flow.png)");
    expect(clip.markdown).not.toContain("alert");
    expect(clip.markdown).not.toContain("소개");
  });

  it("gives null for a page with no text", () => {
    expect(clipPage("<html><body></body></html>", "https://a.com/")).toBeNull();
  });
});

describe("clip note", () => {
  it("makes a safe file name and a note with its source", () => {
    expect(clipFileName('A/B: "C" | D?')).toBe("A B C D");
    expect(clipFileName("   ")).toBe("웹 클립");
    const note = clipNote({ title: "제목", markdown: "본문", site: "블로그", byline: "" }, "https://a.com/x", "2026-11-02");
    expect(note).toBe(
      '---\ntype: clip\nsource: "https://a.com/x"\nsite: "블로그"\ncreated: 2026-11-02\n---\n\n# 제목\n\n> 원문: [블로그](https://a.com/x)\n\n본문\n',
    );
  });
});
