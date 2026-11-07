// SCR-01 시작 화면: 노트 폴더 열기·만들기, 최근 노트 폴더 목록.
import logo from "../../src-tauri/app-icon.svg?url";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type DriveRoot, type RecentVault } from "../api";
import { useApp } from "../store";

import { tx } from "../i18n";
// Reopen the last vault only when the app starts, not after "노트 폴더 바꾸기" (FR-VLT-02).
let autoOpenTried = false;

export function StartScreen() {
  const openVault = useApp((s) => s.openVault);
  const [recent, setRecent] = useState<RecentVault[]>([]);
  const [drives, setDrives] = useState<DriveRoot[]>([]);
  const [checking, setChecking] = useState<string | null>(null);
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  // A network folder can take over 30 seconds to answer; only the latest choice counts.
  const choice = useRef(0);

  async function choose(path: string) {
    const mine = ++choice.current;
    setChecking(path);
    const there = await api.folderExists(path).catch(() => false);
    if (mine !== choice.current) return;
    setChecking(null);
    setMissing((m) => {
      const next = new Set(m);
      if (there) next.delete(path);
      else next.add(path);
      return next;
    });
    if (there) await openVault(path);
  }

  function cancelChoice() {
    choice.current++;
    setChecking(null);
  }

  useEffect(() => {
    api.installedDrives().then(setDrives).catch(() => setDrives([]));
  }, []);
  useEffect(() => {
    const autoOpen = !autoOpenTried;
    autoOpenTried = true;
    api
      .recentVaults()
      .then((list) => {
        setRecent(list);
        if (autoOpen && list[0]) void choose(list[0].path);
      })
      .catch(() => setRecent([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pick(title: string, defaultPath?: string) {
    cancelChoice();
    const dir = await open({ directory: true, multiple: false, title, defaultPath });
    if (typeof dir === "string") await openVault(dir);
  }

  async function forget(path: string) {
    if (path === checking) cancelChoice();
    await api.forgetVault(path);
    setRecent((list) => list.filter((v) => v.path !== path));
  }

  return (
    <div className="start">
      <div className="start-card">
        <div className="start-brand">
          <img className="logo-mark" src={logo} alt="" />
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

        {drives.length > 0 && (
          <div className="start-actions start-drives">
            {drives.map((d) => (
              <button key={d.root} className="btn" title={d.start} onClick={() => pick(tx("{0}에서 열 노트 폴더 선택", d.name), d.start)}>
                {tx("{0}에서 열기", d.name)}
              </button>
            ))}
          </div>
        )}

        <h2 className="section-label">{tx("최근 노트 폴더")}</h2>
        {recent.length === 0 ? (
          <p className="muted small">{tx("아직 연 노트 폴더가 없습니다.")}</p>
        ) : (
          <ul className="recent-list">
            {recent.map((v) => (
              <li
                key={v.path}
                className={missing.has(v.path) ? "missing" : ""}
                title={missing.has(v.path) ? tx("찾을 수 없음 · 우클릭해 목록에서 제거") : v.path}
                onClick={() => void choose(v.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  forget(v.path);
                }}
              >
                <span className="recent-name">{v.name}</span>
                <span className="recent-path">{checking === v.path ? tx("확인 중…") : missing.has(v.path) ? tx("찾을 수 없음") : v.path}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">{tx("우클릭하면 목록에서 제거합니다.")}</p>
      </div>
    </div>
  );
}
