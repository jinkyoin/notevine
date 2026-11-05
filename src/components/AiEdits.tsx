// AI 노트 작업 확인: AI가 제안한 새 노트·덧붙이기·고치기를 노트별로 비교해 보여 주고,
// 체크한 것만 적용한다. AI는 파일을 직접 바꾸지 못하고, 적용은 앱이 히스토리를 남기며 한다.
import { useMemo, useState } from "react";
import { useAi, type EditItem } from "../aiStore";
import { diffHunks, EDIT_KIND_LABEL, lineDiff } from "../lib/aiEdits";
import { noteTitle } from "../lib/tree";

import { tx } from "../i18n";
export function AiEdits() {
  const edits = useAi((s) => s.edits);
  const { toggleEdit, applyEdits, closeEdits } = useAi.getState();
  if (!edits) return null;
  const ready = edits.items.filter((it) => it.checked && !it.error).length;

  return (
    <div className="modal-backdrop" onMouseDown={closeEdits} onKeyDown={(e) => e.key === "Escape" && closeEdits()}>
      <div className="modal ai-edits" tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="vv-head">
          <h2>{tx("AI 노트 작업")}</h2>
          <button className="icon-btn" title={tx("닫기 (Esc)")} onClick={closeEdits}>
            ×
          </button>
        </div>
        <div className="ae-body">
          <p className="ae-request">
            <span className="muted small">{tx("요청")}</span> {edits.request}
          </p>
          {edits.message && <p className="ae-message">{edits.message}</p>}
          {edits.items.map((it, i) => (
            <EditCard key={i} item={it} open={edits.items.length <= 3} onToggle={(on) => toggleEdit(i, on)} />
          ))}
        </div>
        <div className="ae-foot">
          <span className="muted small">{tx("적용하면 히스토리에 남아 언제든 되돌릴 수 있습니다. 지우기·이름 바꾸기는 하지 않습니다.")}</span>
          <span className="spacer" />
          <button className="btn" onClick={closeEdits} disabled={edits.applying}>
            {tx("취소")}
          </button>
          <button className="btn primary" disabled={edits.applying || !ready} onClick={() => void applyEdits()}>
            {edits.applying ? tx("적용하는 중…") : tx("선택한 {0}개 적용", ready)}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditCard({ item, open, onToggle }: { item: EditItem; open: boolean; onToggle: (on: boolean) => void }) {
  const [show, setShow] = useState(open);
  const rows = useMemo(() => diffHunks(lineDiff(item.before, item.after)), [item.before, item.after]);
  const added = rows.filter((r) => "kind" in r && r.kind === "add").length;
  const removed = rows.filter((r) => "kind" in r && r.kind === "del").length;
  return (
    <div className={`ae-card ${item.error ? "bad" : ""}`}>
      <label className="ae-card-head">
        <input type="checkbox" checked={item.checked} disabled={!!item.error} onChange={(e) => onToggle(e.target.checked)} />
        <span className={`ae-kind ${item.edit.kind}`}>{EDIT_KIND_LABEL[item.edit.kind]}</span>
        <span className="ae-title" title={item.path}>
          {noteTitle(item.path)}
        </span>
        <span className="muted small ae-path">{item.path}</span>
        {!item.error && (
          <span className="small ae-count">
            <span className="ae-plus">+{added}</span> <span className="ae-minus">−{removed}</span>
          </span>
        )}
        {!item.error && (
          <button
            type="button"
            className="link-btn small"
            onClick={(e) => {
              e.preventDefault();
              setShow(!show);
            }}
          >
            {show ? tx("접기") : tx("바뀌는 부분 보기")}
          </button>
        )}
      </label>
      {item.error && <div className="error small ae-error">{tx("적용할 수 없음: {0}", item.error)}</div>}
      {show && !item.error && (
        <pre className="ae-diff">
          {rows.map((r, i) =>
            "skip" in r ? (
              <div key={i} className="ae-skip">
                {tx("… 같은 줄 {0}개", r.skip)}
              </div>
            ) : (
              <div key={i} className={`ae-row ${r.kind}`}>
                <span className="ae-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                {r.text || " "}
              </div>
            ),
          )}
        </pre>
      )}
    </div>
  );
}
