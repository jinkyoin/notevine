// SCR-10 버전 보기·비교: 이 버전 / 현재와 비교 / 이전 버전과 비교, 내용 복사, 이 버전으로 복원 (FR-HIS-04~06).
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, type DiffLine } from "../api";
import { useApp } from "../store";
import { findNode, noteTitle } from "../lib/tree";
import { ORIGIN_LABEL, sizeDelta, useVersions } from "./HistoryPanel";

type Mode = "only" | "current" | "previous";

export function VersionView() {
  const view = useApp((s) => s.versionView);
  const setVersionView = useApp((s) => s.setVersionView);
  if (!view) return null;
  return <Viewer path={view.path} initial={view.id} close={() => setVersionView(null)} />;
}

function Viewer({ path, initial, close }: { path: string; initial: number | null; close: () => void }) {
  const versions = useVersions(path);
  const [id, setId] = useState<number | null>(initial);
  const [mode, setMode] = useState<Mode>("only");
  const [content, setContent] = useState("");
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const exists = !!findNode(useApp.getState().tree, path);

  useEffect(() => {
    if (id === null && versions.length) setId(versions[0].id);
  }, [id, versions]);

  const idx = versions.findIndex((v) => v.id === id);
  const prevId = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1].id : null;

  useEffect(() => {
    if (id === null) return;
    setError(null);
    const p =
      mode === "only"
        ? api.versionContent(id).then((c) => setContent(c))
        : mode === "current"
          ? api.versionDiff(path, id, null).then(setDiff)
          : prevId === null
            ? Promise.resolve(setDiff([]))
            : api.versionDiff(path, prevId, id).then(setDiff);
    p.catch((e) => setError(errorMessage(e)));
  }, [id, mode, path, prevId]);

  const restore = async () => {
    if (id === null) return;
    const ok = await ask("현재 내용은 새 버전으로 저장된 뒤 복원됩니다. 복원할까요?", { title: "이 버전으로 복원", kind: "warning" });
    if (!ok) return;
    const st = useApp.getState();
    await st.flushEditor(true);
    try {
      await api.restoreVersion(path, id);
    } catch (e) {
      return st.toast(`복원하지 못했습니다: ${errorMessage(e)}`, "error");
    }
    await st.refreshTree();
    // The restore is the app's own write, so the watcher stays quiet: tell the editor directly.
    useApp.setState({ externalSeq: st.externalSeq + 1, externalPaths: [path] });
    st.noteSaved();
    if (st.openPath !== path) st.openNote(path);
    st.toast("복원했습니다 · 복원 전 내용은 히스토리에 남아 있습니다");
    close();
  };

  const copy = async () => {
    if (id === null) return;
    const text = mode === "only" ? content : await api.versionContent(id);
    await navigator.clipboard.writeText(text);
    useApp.getState().toast("버전 내용을 복사했습니다");
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        else if (e.key === "ArrowDown" && idx + 1 < versions.length) setId(versions[idx + 1].id);
        else if (e.key === "ArrowUp" && idx > 0) setId(versions[idx - 1].id);
        else return;
        e.preventDefault();
      }}
    >
      <div className="modal version-view" tabIndex={-1} ref={(el) => el?.focus()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="vv-head">
          <h2>
            {noteTitle(path)} <span className="muted small">{exists ? "히스토리" : "삭제된 노트 히스토리"}</span>
          </h2>
          <button className="icon-btn" title="닫기 (Esc)" onClick={close}>
            ×
          </button>
        </div>
        <div className="vv-body">
          <ul className="vv-list">
            {versions.map((v, i) => (
              <li key={v.id} className={v.id === id ? "sel" : ""} onClick={() => setId(v.id)}>
                <div>{new Date(v.saved_at).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
                <div className="muted small">
                  {i === versions.length - 1 ? "처음 생성" : ORIGIN_LABEL[v.origin]} · {sizeDelta(v.size, versions[i + 1]?.size)}
                </div>
              </li>
            ))}
          </ul>
          <div className="vv-main">
            <div className="vv-modes">
              {(
                [
                  ["only", "이 버전"],
                  ["current", "현재와 비교"],
                  ["previous", "이전 버전과 비교"],
                ] as [Mode, string][]
              ).map(([m, label]) => (
                <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                  {label}
                </button>
              ))}
            </div>
            {error && <p className="error pad small">{error}</p>}
            {mode === "only" ? (
              <pre className="vv-content">{content}</pre>
            ) : mode === "previous" && prevId === null ? (
              <p className="muted pad">처음 버전이라 비교할 이전 버전이 없습니다.</p>
            ) : (
              <div className="vv-diff">
                {diff.every((d) => d.kind === "same") && <p className="muted small pad">차이가 없습니다.</p>}
                {diff.map((d, i) => (
                  <div key={i} className={`dl ${d.kind}`}>
                    <span className="ln">{d.old_no ?? ""}</span>
                    <span className="ln">{d.new_no ?? ""}</span>
                    <span className="sign">{d.kind === "add" ? "+" : d.kind === "del" ? "−" : " "}</span>
                    <span className="txt">{d.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => void copy()} disabled={id === null}>
            내용 복사
          </button>
          <button className="btn primary" onClick={() => void restore()} disabled={id === null}>
            {exists ? "이 버전으로 복원" : "이 버전으로 노트 되살리기"}
          </button>
        </div>
      </div>
    </div>
  );
}
