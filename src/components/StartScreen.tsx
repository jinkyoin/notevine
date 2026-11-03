// SCR-01 시작 화면: 노트 폴더 열기·만들기, 최근 노트 폴더 목록.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type RecentVault } from "../api";
import { useApp } from "../store";

import { tx } from "../i18n";
// Reopen the last vault only when the app starts, not after "노트 폴더 바꾸기" (FR-VLT-02).
let autoOpenTried = false;

export function StartScreen() {
  const openVault = useApp((s) => s.openVault);
  const [recent, setRecent] = useState<RecentVault[]>([]);

  const loadRecent = () => api.recentVaults().then(setRecent).catch(() => setRecent([]));
  useEffect(() => {
    if (!autoOpenTried) {
      autoOpenTried = true;
      api
        .recentVaults()
        .then((list) => {
          if (list[0]?.exists) openVault(list[0].path);
          else setRecent(list);
        })
        .catch(() => setRecent([]));
      return;
    }
    loadRecent();
  }, [openVault]);

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
        <p className="muted">{tx("내 컴퓨터의 마크다운 폴더에 기록하고, 연결하고, 다시 찾습니다.")}</p>

        <div className="start-actions">
          <button className="btn primary" onClick={() => pick(tx("열 노트 폴더 선택"))}>
            {tx("노트 폴더 열기")}
          </button>
          <button className="btn" onClick={() => pick(tx("새 노트 폴더로 쓸 폴더 선택 (빈 폴더 권장)"))}>
            {tx("새 노트 폴더 만들기")}
          </button>
        </div>

        <h2 className="section-label">{tx("최근 노트 폴더")}</h2>
        {recent.length === 0 ? (
          <p className="muted small">{tx("아직 연 노트 폴더가 없습니다.")}</p>
        ) : (
          <ul className="recent-list">
            {recent.map((v) => (
              <li
                key={v.path}
                className={v.exists ? "" : "missing"}
                title={v.exists ? v.path : tx("찾을 수 없음 · 우클릭해 목록에서 제거")}
                onClick={() => v.exists && openVault(v.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  forget(v.path);
                }}
              >
                <span className="recent-name">{v.name}</span>
                <span className="recent-path">{v.exists ? v.path : tx("찾을 수 없음")}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">{tx("우클릭하면 목록에서 제거합니다.")}</p>
      </div>
    </div>
  );
}
