import { useApp } from "../store";
import { tx } from "../i18n";

/** "‹ 노트 이름": back to the note under the PDF or canvas (Esc, Alt+←). */
export function BackButton({ onClick }: { onClick: () => void }) {
  const openPath = useApp((s) => s.openPath);
  const name = openPath ? openPath.slice(openPath.lastIndexOf("/") + 1).replace(/\.md$/i, "") : null;
  return (
    <button className="btn ghost small view-back" onClick={onClick} title={tx("돌아가기 (Esc · Alt+←)")}>
      ‹ {name ?? tx("닫기")}
    </button>
  );
}
