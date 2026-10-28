// SCR-02 메인 화면: 상단바 + 왼쪽 사이드바 + 편집기 + 오른쪽 패널(4일 차부터 내용).
import { useEffect, useState } from "react";
import { useApp } from "../store";
import { Explorer } from "./Explorer";
import { Editor } from "./Editor";
import { Backlinks } from "./Backlinks";
import { RelocateDialog } from "./RelocateDialog";
import { SearchPanel } from "./SearchPanel";
import { QuickOpen } from "./QuickOpen";
import { PropertiesPanel } from "./PropertiesPanel";

export function MainLayout() {
  const vault = useApp((s) => s.vault);
  const openPath = useApp((s) => s.openPath);
  const closeVault = useApp((s) => s.closeVault);
  const createNote = useApp((s) => s.createNote);
  const sidebarTab = useApp((s) => s.sidebarTab);
  const setSidebarTab = useApp((s) => s.setSidebarTab);
  const focusSearch = useApp((s) => s.focusSearch);
  const setQuickOpen = useApp((s) => s.setQuickOpen);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === "o" && !e.shiftKey) setQuickOpen(true);
      else if (k === "f" && e.shiftKey) {
        setLeftOpen(true);
        focusSearch();
      } else if (e.key === "\\" && !e.shiftKey) setLeftOpen((v) => !v);
      else if (e.key === "|" || (e.key === "\\" && e.shiftKey)) setRightOpen((v) => !v);
      else if (e.key.toLowerCase() === "n" && !e.shiftKey) createNote("");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createNote, focusSearch, setQuickOpen]);

  const crumbs = openPath ? openPath.split("/") : [];

  return (
    <div className="main">
      <header className="topbar">
        <button className="icon-btn" title="왼쪽 사이드바 (Ctrl+\)" onClick={() => setLeftOpen((v) => !v)}>
          ☰
        </button>
        <span className="vault-name" title={vault?.root}>
          {vault?.name}
        </span>
        <nav className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="sep">›</span>}
              {i === crumbs.length - 1 ? c.replace(/\.md$/i, "") : c}
            </span>
          ))}
        </nav>
        <span className="spacer" />
        <button className="btn ghost small" onClick={closeVault} title="볼트 닫고 시작 화면으로">
          볼트 바꾸기
        </button>
        <button className="icon-btn" title="오른쪽 패널 (Ctrl+Shift+\)" onClick={() => setRightOpen((v) => !v)}>
          ▤
        </button>
      </header>
      <div className="body">
        {leftOpen && (
          <aside className="sidebar">
            <div className="side-tabs" role="tablist">
              <button role="tab" className={sidebarTab === "files" ? "on" : ""} onClick={() => setSidebarTab("files")}>
                파일
              </button>
              <button role="tab" className={sidebarTab === "search" ? "on" : ""} onClick={focusSearch} title="Ctrl+Shift+F">
                검색
              </button>
            </div>
            {sidebarTab === "files" ? <Explorer /> : <SearchPanel />}
          </aside>
        )}
        <main className="center">
          {openPath ? (
            <Editor key={openPath} path={openPath} />
          ) : (
            <div className="empty">
              <p>열린 노트가 없습니다.</p>
              <button className="btn primary" onClick={() => createNote("")}>
                새 노트 (Ctrl+N)
              </button>
            </div>
          )}
        </main>
        {rightOpen && (
          <aside className="rightpanel">
            {openPath && <PropertiesPanel />}
            <Backlinks />
          </aside>
        )}
      </div>
      <RelocateDialog />
      <QuickOpen />
    </div>
  );
}
