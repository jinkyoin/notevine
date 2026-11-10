// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { clipFetched, clipFileName, clipNote, clipPage, saveClipImages } from "./clip";

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

describe("clipPage tables", () => {
  const page = (table: string) =>
    `<html><head><title>표 정리</title></head><body><article><h1>표 정리</h1>
<p>본문으로 뽑히도록 충분히 긴 문단이다. 아래 표는 배점과 기간을 정리한 것이다. 표가 마크다운 표로 남는지 본다. 한 문장 더 쓴다.</p>
${table}
<p>표 다음 문단도 충분히 길게 쓴다. 본문 판정은 글자 수를 보기 때문에 이렇게 길게 적어 둔다. 끝.</p></article></body></html>`;
  const md = (table: string) => clipPage(page(table), "https://x.example/a")!.markdown;

  it("keeps a table as a markdown table", () => {
    const out = md(`<table><thead><tr><th>항목</th><th>배점</th></tr></thead>
<tbody><tr><td>기술 <b>평가</b></td><td>80</td></tr><tr><td>가격 | 평가</td><td>20</td></tr></tbody></table>`);
    expect(out).toContain("| 항목 | 배점 |\n| --- | --- |\n| 기술 **평가** | 80 |\n| 가격 \\| 평가 | 20 |");
  });

  it("uses the first row as the header when there is no th, and fills merged cells", () => {
    const out = md(`<table><tr><td>구분</td><td colspan="2">기간</td></tr>
<tr><td rowspan="2">1차</td><td>착수</td><td>1월</td></tr><tr><td>완료</td><td>3월</td></tr></table>`);
    expect(out).toContain("| 구분 | 기간 |  |\n| --- | --- | --- |\n| 1차 | 착수 | 1월 |\n|  | 완료 | 3월 |");
  });

  it("keeps lines inside a cell with <br>", () => {
    const out = md(`<table><tr><th>단계</th><th>할 일</th></tr><tr><td>준비</td><td><p>요구 분석</p><p>설계</p></td></tr></table>`);
    expect(out).toContain("| 준비 | 요구 분석<br>설계 |");
  });

  it("a one-column layout table is just its content", () => {
    const out = md(`<table><tr><td><p>레이아웃 표 안의 문단이다.</p></td></tr><tr><td><p>두 번째 문단.</p></td></tr></table>`);
    expect(out).toContain("레이아웃 표 안의 문단이다.\n\n두 번째 문단.");
    expect(out).not.toContain("| ---");
  });

  it("a one-row layout table (a notice box) is just its content", () => {
    const out = md(`<table><tr><td><img src="i.png" alt="!"></td><td><p>이 문서는 <b>오래된 정보</b>를 담고 있습니다.</p></td></tr></table>`);
    expect(out).toContain("이 문서는 **오래된 정보**를 담고 있습니다.");
    expect(out).not.toContain("| ---");
  });
});

describe("clipFetched", () => {
  const SHELL = (frame: string) => `<html><head><title>겉 페이지</title></head><body>${frame}</body></html>`;
  const page = (html: string, url = "https://blog.example.com/user/1") => ({ url, html });
  const ARTICLE = `<html><head><title>안쪽 글</title></head><body><article>
    <p>본문입니다. ${"충분히 긴 문장을 여러 번 적어 본문으로 읽히게 한다. ".repeat(20)}</p>
    <img src="/thumb.png?type=w80_blur" data-lazy-src="/full.png">
    <img src="/small.png" data-src="/large.png">
    <img src="/plain.png">
  </article></body></html>`;

  it("takes the article from the frame a shell page shows it in", async () => {
    const fetchPage = vi.fn(async (url: string) => page(ARTICLE, url));
    const clip = await clipFetched(page(SHELL('<iframe id="mainFrame" src="/PostView?id=1"></iframe>')), fetchPage);
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith("https://blog.example.com/PostView?id=1");
    expect(clip?.markdown).toContain("본문입니다");
  });

  it("keeps the real picture, not the blurred placeholder of a lazy image", async () => {
    const clip = await clipFetched(page(ARTICLE), vi.fn());
    expect(clip?.markdown).toContain("https://blog.example.com/full.png");
    expect(clip?.markdown).toContain("https://blog.example.com/large.png");
    expect(clip?.markdown).toContain("https://blog.example.com/plain.png");
    expect(clip?.markdown).not.toContain("w80_blur");
  });

  it("does not fetch when the page already has an article", async () => {
    const fetchPage = vi.fn();
    expect(await clipFetched(page(ARTICLE), fetchPage)).not.toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    ["another host", '<iframe src="https://ads.example.net/x"></iframe>'],
    ["this PC", '<iframe src="http://localhost:8080/admin"></iframe>'],
    ["not a web address", '<iframe src="file:///C:/secret.txt"></iframe>'],
    ["several frames, none the main one", '<iframe src="/a"></iframe><iframe src="/b"></iframe>'],
  ])("does not follow a frame to %s", async (_name, frame) => {
    const fetchPage = vi.fn();
    expect(await clipFetched(page(SHELL(frame)), fetchPage)).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("follows one frame at most", async () => {
    const shell = SHELL('<iframe id="mainFrame" src="/again"></iframe>');
    const fetchPage = vi.fn(async (url: string) => page(shell, url));
    expect(await clipFetched(page(shell), fetchPage)).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe("saveClipImages", () => {
  const saved = (url: string) => Promise.resolve(`첨부/${url.split("/").pop()}`);

  it("swaps web pictures for the saved attachments", async () => {
    const r = await saveClipImages('글 ![](https://a.com/1.png) 그리고 ![설명](https://a.com/2.png "제목")', saved);
    expect(r).toEqual({ markdown: "글 ![[첨부/1.png]] 그리고 ![[첨부/2.png|설명]]", failed: 0, saved: 2 });
  });

  it("drops the link wrapped around a picture", async () => {
    const r = await saveClipImages("[![](https://a.com/1.png)](https://blog.example.com/post#)", saved);
    expect(r.markdown).toBe("![[첨부/1.png]]");
  });

  it("downloads a picture used twice only once", async () => {
    const save = vi.fn(saved);
    const r = await saveClipImages("![](https://a.com/1.png)\n\n![](https://a.com/1.png)", save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(r.markdown).toBe("![[첨부/1.png]]\n\n![[첨부/1.png]]");
  });

  it("leaves a picture it could not get as a web address and counts it", async () => {
    const save = vi.fn(async (url: string) => {
      if (url.endsWith("bad.png")) throw new Error("no");
      return saved(url);
    });
    const r = await saveClipImages("[![](https://a.com/bad.png)](https://x.y/) ![](https://a.com/ok.png)", save);
    expect(r).toEqual({ markdown: "[![](https://a.com/bad.png)](https://x.y/) ![[첨부/ok.png]]", failed: 1, saved: 1 });
  });

  it("does not touch pictures written as code", async () => {
    const code = "```\n![](https://a.com/in-fence.png)\n```\n\n`![](https://a.com/inline.png)`";
    const save = vi.fn(saved);
    expect((await saveClipImages(code, save)).markdown).toBe(code);
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps a caption that cannot be a label out of the link", async () => {
    const r = await saveClipImages("![300](https://a.com/1.png) ![a|b]c](https://a.com/2.png) ![a|b](https://a.com/3.png)", saved);
    expect(r.markdown).toContain("![[첨부/1.png]]"); // a number would read as a width
    expect(r.markdown).toContain("![[첨부/3.png|a b]]");
  });

  it("gets at most the limit, the rest stay web addresses", async () => {
    const md = Array.from({ length: 53 }, (_, i) => `![](https://a.com/${i}.png)`).join("\n");
    const r = await saveClipImages(md, saved);
    expect(r.saved).toBe(50);
    expect(r.failed).toBe(3);
    expect(r.markdown).toContain("![[첨부/49.png]]");
    expect(r.markdown).toContain("![](https://a.com/50.png)");
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
