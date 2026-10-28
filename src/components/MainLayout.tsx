// SCR-02 메인 화면: 상단바 + 왼쪽 사이드바(파일·검색·아이디어) + 편집기 + 오른쪽 패널(속성·백링크·히스토리).
import { useEffect } from "react";
import { useApp } from "../store";
import { dispatchKey } from "../commands";
import { Explorer } from "./Explorer";
import { Editor } from "./Editor";
import { Backlinks } from "./Backlinks";
import { RelocateDialog } from "./RelocateDialog";
import { SearchPanel } from "./SearchPanel";
import { QuickOpen } from "./QuickOpen";
import { PropertiesPanel } from "./PropertiesPanel";
import { HistoryPanel } from "./HistoryPanel";
import { VersionView } from "./VersionView";
import { DeletedNotes } from "./DeletedNotes";
import { IdeaBoard } from "./IdeaBoard";
import { CommandPalette } from "./CommandPalette";
import { QuickMemo } from "./QuickMemo";
import { TemplatePicker } from "./TemplatePicker";
import { Settings } from "./Settings";
import { ConfirmDialog } from "./ConfirmDialog";
import { AiPanel } from "./AiPanel";
import { AiPreview, AiSendConfirm } from "./AiDialogs";

export function MainLayout() {
  const vault = useApp((s) => s.vault);
  const openPath = useApp((s) => s.openPath);
  const sidebarTab = useApp((s) => s.sidebarTab);
  const preset = useApp((s) => s.config.preset_enabled);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const canBack = useApp((s) => s.back.length > 0);
  const canForward = useApp((s) => s.forward.length > 0);
  const { setSidebarTab, focusSearch, setPanels, setModal, goBack, goForward, openTodayJournal } = useApp.getState();

  // All shortcuts go through the command registry (FR-EXT-01).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => void dispatchKey(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const crumbs = openPath ? openPath.split("/") : [];

  return (
    <div className="main">
      <header className="topbar">
        <button className="icon-btn" title="왼쪽 사이드바 (Ctrl+\)" onClick={() => setPanels({ leftOpen: !leftOpen })}>
          ☰
        </button>
        <button className="icon-btn" title="이전 노트 (Alt+←)" disabled={!canBack} onClick={goBack}>
          ‹
        </button>
        <button className="icon-btn" title="다음 노트 (Alt+→)" disabled={!canForward} onClick={goForward}>
          ›
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
        <button className="btn ghost small" onClick={() => void openTodayJournal()} title="Ctrl+Shift+D">
          오늘 업무일지
        </button>
        <button className="btn ghost small" onClick={() => setModal("quickMemo")} title="Ctrl+Shift+N">
          빠른 메모
        </button>
        <button className="icon-btn" title="명령 팔레트 (Ctrl+P)" onClick={() => setModal("palette")}>
          ⌘
        </button>
        <button className="icon-btn" title="설정 (Ctrl+,)" onClick={() => setModal("settings")}>
          ⚙
        </button>
        <button className="icon-btn" title="오른쪽 패널 (Ctrl+Shift+\)" onClick={() => setPanels({ rightOpen: !rightOpen })}>
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
              {preset && (
                <button role="tab" className={sidebarTab === "ideas" ? "on" : ""} onClick={() => setSidebarTab("ideas")}>
                  아이디어
                </button>
              )}
            </div>
            {sidebarTab === "search" ? <SearchPanel /> : sidebarTab === "ideas" && preset ? <IdeaBoard /> : <Explorer />}
          </aside>
        )}
        <main className="center">
          {openPath ? (
            <Editor key={openPath} path={openPath} />
          ) : (
            <div className="empty">
              <p>열린 노트가 없습니다.</p>
              <button className="btn primary" onClick={() => setModal("template")}>
                새 노트 (Ctrl+N)
              </button>
              {!preset && (
                <p className="muted small">
                  업무일지·아이디어·조사자료를 정리하려면{" "}
                  <button className="link-btn" onClick={() => void useApp.getState().applyPreset()}>
                    업무일지·아이디어 기능 켜기
                  </button>
                </p>
              )}
            </div>
          )}
        </main>
        {rightOpen && (
          <aside className="rightpanel">
            {/* Note info on top, the AI assistant always below it (SCR-18). */}
            <div className="info-scroll">
              {openPath && <PropertiesPanel />}
              <Backlinks />
              <HistoryPanel />
            </div>
            <div className="ai-dock">
              <AiPanel />
            </div>
          </aside>
        )}
      </div>
      <RelocateDialog />
      <QuickOpen />
      <CommandPalette />
      <QuickMemo />
      <TemplatePicker />
      <Settings />
      <DeletedNotes />
      <VersionView />
      <ConfirmDialog />
      <AiSendConfirm />
      <AiPreview />
    </div>
  );
}
