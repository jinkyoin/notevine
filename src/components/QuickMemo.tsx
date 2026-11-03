// SCR-13 빠른 메모 (Ctrl+Shift+N): 첫 줄이 제목. 프리셋이 켜져 있으면 Inbox에 아이디어로 저장한다 (FR-PRS-04).
import { useState } from "react";
import { api, errorMessage } from "../api";
import { useApp } from "../store";

import { tx } from "../i18n";
export function QuickMemo() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  if (modal !== "quickMemo") return null;
  return <Memo close={() => setModal(null)} />;
}

function Memo({ close }: { close: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast, refreshTree, openNote, config } = useApp.getState();

  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const firstLine = text.split(/\r?\n/)[0].trim();
    try {
      const path = await api.quickMemo(text, firstLine || null);
      close();
      await refreshTree();
      toast(config.preset_enabled ? tx("Inbox에 저장됨") : tx("메모를 저장했습니다"), "info", { label: tx("열기"), run: () => openNote(path) });
    } catch (e) {
      setBusy(false);
      toast(tx("메모를 저장하지 못했습니다: {0}", errorMessage(e)), "error");
    }
  };

  return (
    <div className="modal-backdrop top" onMouseDown={close}>
      <div className="palette memo" onMouseDown={(e) => e.stopPropagation()}>
        <div className="memo-head">
          {tx("빠른 메모")}{" "} <span className="muted small">{tx("첫 줄이 제목 · Ctrl+Enter 저장 · Esc 닫기")}</span>
        </div>
        <textarea
          autoFocus
          value={text}
          placeholder={tx("떠오른 생각을 적으세요")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") close();
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
            else return;
            e.preventDefault();
          }}
        />
        <div className="modal-actions pad">
          <button className="btn ghost" onClick={close}>
            {tx("취소")}
          </button>
          <button className="btn primary" disabled={!text.trim() || busy} onClick={() => void save()}>
            {config.preset_enabled ? tx("{0}에 저장", config.inbox_folder) : tx("저장")}
          </button>
        </div>
      </div>
    </div>
  );
}
