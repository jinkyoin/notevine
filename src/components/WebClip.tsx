// 웹 클리핑 (FR-ATT-03): 주소를 넣으면 그 페이지의 본문을 마크다운 노트로 저장한다.
import { useState } from "react";
import { useApp } from "../store";

export function WebClip() {
  const modal = useApp((s) => s.modal);
  if (modal !== "clip") return null;
  return <ClipDialog close={() => useApp.getState().setModal(null)} />;
}

function ClipDialog({ close }: { close: () => void }) {
  const preset = useApp((s) => s.config.preset_enabled);
  const inbox = useApp((s) => s.config.inbox_folder);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^https?:\/\/\S+$/i.test(url.trim());

  const go = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const ok = await useApp.getState().clipWebPage(url.trim());
    setBusy(false);
    if (ok) close();
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && close()} onKeyDown={(e) => e.key === "Escape" && !busy && close()}>
      <div className="modal web-clip" onMouseDown={(e) => e.stopPropagation()}>
        <h2>웹 페이지 클립</h2>
        <p className="muted small">
          웹 페이지의 본문만 골라 노트로 저장합니다. 메뉴·광고는 빼고, 원문 주소는 노트 속성(source)에 남깁니다. 저장
          위치: {preset ? inbox : "노트 폴더 맨 위"}
        </p>
        <input
          className="clip-url"
          autoFocus
          placeholder="https://"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => !e.nativeEvent.isComposing && e.key === "Enter" && void go()}
        />
        <p className="muted small">
          이 주소에 한 번 접속해 페이지를 가져옵니다. 로그인이 필요한 페이지는 본문 대신 로그인 화면이 저장될 수 있습니다.
        </p>
        <div className="modal-actions">
          <button className="btn ghost" disabled={busy} onClick={close}>
            취소
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={() => void go()}>
            {busy ? "가져오는 중…" : "가져오기"}
          </button>
        </div>
      </div>
    </div>
  );
}
