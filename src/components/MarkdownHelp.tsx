// 마크다운 문법 도움말: 편집기에서 쓸 수 있는 문법을 예시와 단축키로 보여 준다 (F1, 서식 막대의 ? 단추).
import { useApp } from "../store";

import { tx } from "../i18n";
type Row = [syntax: string, meaning: string, keys?: string];

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: tx("제목"),
    rows: [
      [tx("# 제목 1"), tx("가장 큰 제목")],
      [tx("## 제목 2"), tx("중간 제목")],
      [tx("### 제목 3"), tx("작은 제목 (#은 6개까지)")],
    ],
  },
  {
    title: tx("글자 모양"),
    rows: [
      [tx("**굵게**"), tx("굵은 글씨"), "Ctrl+B"],
      [tx("*기울임*"), tx("기울인 글씨"), "Ctrl+I"],
      [tx("~~취소선~~"), tx("가운데 줄"), "Ctrl+Shift+X"],
      [tx("==형광펜=="), tx("형광펜 강조"), "Ctrl+Shift+H"],
      [tx("`코드`"), tx("글 안의 짧은 코드"), "Ctrl+`"],
      [tx("<span style=\"color: #e03131\">빨강</span>"), tx("글자 색 (서식 막대의 A 단추로 넣기)")],
    ],
  },
  {
    title: tx("목록·인용"),
    rows: [
      [tx("- 항목"), tx("글머리 목록 (Tab으로 들여쓰기)")],
      [tx("1. 항목"), tx("번호 목록")],
      [tx("- [ ] 할 일"), tx("체크리스트 (읽기 모드에서 눌러 체크)"), "Ctrl+L"],
      [tx("- [x] 한 일"), tx("체크한 항목")],
      [tx("> 인용"), tx("인용문")],
      [tx("> [!중요] 제목\n> 내용"), tx("강조 상자: 중요·주의·참고·팁·결정·질문·아이디어 (서식 막대의 ! 단추로 넣기)")],
    ],
  },
  {
    title: tx("링크·그림"),
    rows: [
      [tx("[[노트 이름]]"), tx("다른 노트로 가는 링크 ([[ 입력하면 자동완성)")],
      [tx("[[노트 이름|보일 글]]"), tx("다른 이름으로 보이는 노트 링크")],
      [tx("[[노트 이름#제목]]"), tx("노트의 그 제목으로 바로 가기")],
      [tx("[[#제목]]"), tx("이 노트 안의 제목으로 가기")],
      [tx("![[노트 이름]]"), tx("다른 노트 내용을 그 자리에 보여주기 (읽기 모드)")],
      [tx("![[노트 이름#제목]]"), tx("그 제목 아래 부분만 보여주기")],
      [tx("![[그림.png]]"), tx("노트 폴더 안의 그림 넣기")],
      [tx("![[그림.png|300]]"), tx("그림 폭을 300px로")],
      [tx("[보일 글](https://…)"), tx("웹 링크"), "Ctrl+K"],
      [tx("#태그"), tx("태그 (읽기 모드에서 누르면 같은 태그 검색)")],
    ],
  },
  {
    title: tx("블록"),
    rows: [
      [tx("```js\n코드\n```"), tx("코드 블록 (``` 뒤에 언어 이름)")],
      [tx("| 열 | 열 |\n| --- | --- |\n| 칸 | 칸 |"), tx("표")],
      ["$E=mc^2$", tx("글 안의 수식 (읽기 모드에서 그려짐, 돈 $5는 그대로)")],
      ["$$\n\\frac{1}{3}\n$$", tx("한 줄을 차지하는 수식")],
      ["```mermaid\ngraph TD\n  A --> B\n```", tx("다이어그램 (읽기 모드에서 그려짐)")],
      ["---", tx("구분선 (앞뒤로 빈 줄)")],
      [tx("---\ntags: [회의]\n---"), tx("노트 맨 위: 속성 (오른쪽 패널에 표시)")],
    ],
  },
];

export function MarkdownHelp() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  if (modal !== "mdHelp") return null;
  const close = () => setModal(null);
  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="modal md-help" tabIndex={-1} ref={(el) => el?.focus()} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{tx("마크다운 문법 도움말")}</h2>
        <p className="muted small">{tx("왼쪽처럼 입력하면 편집 화면과 읽기 모드(Ctrl+E)에서 서식이 적용됩니다.")}</p>
        <div className="md-help-body">
          {SECTIONS.map((sec) => (
            <section key={sec.title}>
              <h3>{sec.title}</h3>
              <table>
                <tbody>
                  {sec.rows.map(([syntax, meaning, keys]) => (
                    <tr key={syntax}>
                      <td>
                        <code>{syntax}</code>
                      </td>
                      <td>
                        {meaning}
                        {keys && <kbd>{keys}</kbd>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setModal("manual")} title="Shift+F1">
            {tx("사용자 매뉴얼")}
          </button>
          <button className="btn" onClick={close}>
            {tx("닫기")}
          </button>
        </div>
      </div>
    </div>
  );
}
