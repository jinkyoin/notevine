// 마크다운 문법 도움말: 편집기에서 쓸 수 있는 문법을 예시와 단축키로 보여 준다 (F1, 서식 막대의 ? 단추).
import { useApp } from "../store";

type Row = [syntax: string, meaning: string, keys?: string];

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: "제목",
    rows: [
      ["# 제목 1", "가장 큰 제목"],
      ["## 제목 2", "중간 제목"],
      ["### 제목 3", "작은 제목 (#은 6개까지)"],
    ],
  },
  {
    title: "글자 모양",
    rows: [
      ["**굵게**", "굵은 글씨", "Ctrl+B"],
      ["*기울임*", "기울인 글씨", "Ctrl+I"],
      ["~~취소선~~", "가운데 줄", "Ctrl+Shift+X"],
      ["==형광펜==", "형광펜 강조", "Ctrl+Shift+H"],
      ["`코드`", "글 안의 짧은 코드", "Ctrl+`"],
      ['<span style="color: #e03131">빨강</span>', "글자 색 (서식 막대의 A 단추로 넣기)"],
    ],
  },
  {
    title: "목록·인용",
    rows: [
      ["- 항목", "글머리 목록 (Tab으로 들여쓰기)"],
      ["1. 항목", "번호 목록"],
      ["- [ ] 할 일", "체크리스트 (읽기 모드에서 눌러 체크)", "Ctrl+L"],
      ["- [x] 한 일", "체크한 항목"],
      ["> 인용", "인용문"],
    ],
  },
  {
    title: "링크·그림",
    rows: [
      ["[[노트 이름]]", "다른 노트로 가는 링크 ([[ 입력하면 자동완성)"],
      ["[[노트 이름|보일 글]]", "다른 이름으로 보이는 노트 링크"],
      ["[[노트 이름#제목]]", "노트의 그 제목으로 바로 가기"],
      ["[[#제목]]", "이 노트 안의 제목으로 가기"],
      ["![[그림.png]]", "볼트 안의 그림 넣기"],
      ["![[그림.png|300]]", "그림 폭을 300px로"],
      ["[보일 글](https://…)", "웹 링크", "Ctrl+K"],
      ["#태그", "태그 (읽기 모드에서 누르면 같은 태그 검색)"],
    ],
  },
  {
    title: "블록",
    rows: [
      ["```js\n코드\n```", "코드 블록 (``` 뒤에 언어 이름)"],
      ["| 열 | 열 |\n| --- | --- |\n| 칸 | 칸 |", "표"],
      ["---", "구분선 (앞뒤로 빈 줄)"],
      ["---\ntags: [회의]\n---", "노트 맨 위: 속성 (오른쪽 패널에 표시)"],
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
        <h2>마크다운 문법 도움말</h2>
        <p className="muted small">왼쪽처럼 입력하면 편집 화면과 읽기 모드(Ctrl+E)에서 서식이 적용됩니다.</p>
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
          <button className="btn" onClick={close}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
