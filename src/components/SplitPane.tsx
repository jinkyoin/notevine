// 분할 창 (FR-EDT-07): 지금 노트 옆 오른쪽 칸에 다른 노트 하나를 열어 나란히 본다.
import { useApp } from "../store";
import { noteTitle } from "../lib/tree";
import { Editor } from "./Editor";

import { tx } from "../i18n";
export function SplitPane({ path }: { path: string }) {
  const openPath = useApp((s) => s.openPath);
  const tableView = useApp((s) => s.tableView);
  const { openNote, closeSplit } = useApp.getState();
  // Two editors on one file would overwrite each other's edits.
  const sameNote = path === openPath && tableView === null;

  return (
    <div className="pane split-pane">
      <div className="split-bar">
        <span className="split-title" title={path}>
          {noteTitle(path)}
        </span>
        <button
          className="icon-btn"
          title={tx("왼쪽(지금 탭)에서 열기")}
          aria-label={tx("왼쪽에서 열기")}
          onClick={() => {
            closeSplit();
            openNote(path);
          }}
        >
          ⇤
        </button>
        <button className="icon-btn" title={tx("나란히 보기 닫기")} aria-label={tx("나란히 보기 닫기")} onClick={closeSplit}>
          ×
        </button>
      </div>
      {sameNote ? (
        <div className="empty">
          <p>{tx("왼쪽에 같은 노트가 열려 있어 여기서는 편집하지 않습니다.")}</p>
          <button className="btn" onClick={closeSplit}>
            {tx("나란히 보기 닫기")}
          </button>
        </div>
      ) : (
        <Editor key={path} path={path} side />
      )}
    </div>
  );
}
