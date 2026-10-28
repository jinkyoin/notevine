// SCR-01 시작 화면: 볼트 열기·만들기, 최근 볼트 목록.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type RecentVault } from "../api";
import { useApp } from "../store";

export function StartScreen() {
  const openVault = useApp((s) => s.openVault);
  const [recent, setRecent] = useState<RecentVault[]>([]);

  const loadRecent = () => api.recentVaults().then(setRecent).catch(() => setRecent([]));
  useEffect(() => {
    loadRecent();
  }, []);

  async function pick(title: string) {
    const dir = await open({ directory: true, multiple: false, title });
    if (typeof dir === "string") await openVault(dir);
  }

  async function forget(path: string) {
    await api.forgetVault(path);
    loadRecent();
  }

  return (
    <div className="start">
      <div className="start-card">
        <div className="start-brand">
          <span className="logo-mark" aria-hidden />
          <h1>Notevine</h1>
        </div>
        <p className="muted">내 컴퓨터의 마크다운 폴더에 기록하고, 연결하고, 다시 찾습니다.</p>

        <div className="start-actions">
          <button className="btn primary" onClick={() => pick("볼트로 열 폴더 선택")}>
            폴더를 볼트로 열기
          </button>
          <button className="btn" onClick={() => pick("새 볼트로 쓸 폴더 선택 (빈 폴더 권장)")}>
            새 볼트 만들기
          </button>
        </div>

        <h2 className="section-label">최근 볼트</h2>
        {recent.length === 0 ? (
          <p className="muted small">아직 연 볼트가 없습니다.</p>
        ) : (
          <ul className="recent-list">
            {recent.map((v) => (
              <li
                key={v.path}
                className={v.exists ? "" : "missing"}
                title={v.exists ? v.path : "찾을 수 없음 · 우클릭해 목록에서 제거"}
                onClick={() => v.exists && openVault(v.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  forget(v.path);
                }}
              >
                <span className="recent-name">{v.name}</span>
                <span className="recent-path">{v.exists ? v.path : "찾을 수 없음"}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">우클릭하면 목록에서 제거합니다.</p>
      </div>
    </div>
  );
}
