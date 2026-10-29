// SCR-02 메인 화면: 상단바 + 왼쪽 사이드바(파일·검색·아이디어) + 편집기 + 오른쪽 패널(속성·백링크·히스토리).
import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
import { MarkdownHelp } from "./MarkdownHelp";
import { IdeaBoard } from "./IdeaBoard";
import { CommandPalette } from "./CommandPalette";
import { QuickMemo } from "./QuickMemo";
import { TemplatePicker } from "./TemplatePicker";
import { Settings } from "./Settings";
import { ConfirmDialog } from "./ConfirmDialog";
import { AiPanel } from "./AiPanel";
import { AiPreview, AiSendConfirm } from "./AiDialogs";

/** The vault name in the top bar; opens a menu to switch to another vault (FR-VLT-02). */
/** A window split into a side column, filled while that panel is open. */
function PanelIcon({ side, open }: { side: "left" | "right"; open: boolean }) {
  const left = side === "left";
  return (
    <svg className="panel-icon" viewBox="0 0 16 16" aria-hidden="true">
      {open && <path className="panel-fill" d={left ? "M2.5 3.2h3.5v9.6H2.5z" : "M10 3.2h3.5v9.6H10z"} />}
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
      <path d={left ? "M6 2.5v11" : "M10 2.5v11"} />
    </svg>
  );
}

function VaultMenu({ name, root }: { name: string; root: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const run = (f: () => void) => {
    setOpen(false);
    f();
  };
  return (
    <div className="vault-menu" ref={box}>
      <button className="vault-name" title={`${root}\n눌러서 볼트 바꾸기`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {name} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => run(() => useApp.getState().closeVault())}>
            볼트 바꾸기…
          </button>
          <button role="menuitem" onClick={() => run(() => void revealItemInDir(root).catch(() => {}))}>
            탐색기에서 볼트 폴더 열기
          </button>
        </div>
      )}
    </div>
  );
}

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
        <button
          className="icon-btn"
          title={leftOpen ? "왼쪽 사이드바 닫기 (Ctrl+\\)" : "왼쪽 사이드바 열기 (Ctrl+\\)"}
          aria-label="왼쪽 사이드바"
          aria-pressed={leftOpen}
          onClick={() => setPanels({ leftOpen: !leftOpen })}
        >
          <PanelIcon side="left" open={leftOpen} />
        </button>
        <button className="icon-btn" title="이전 노트 (Alt+←)" disabled={!canBack} onClick={goBack}>
          ‹
        </button>
        <button className="icon-btn" title="다음 노트 (Alt+→)" disabled={!canForward} onClick={goForward}>
          ›
        </button>
        <VaultMenu name={vault?.name ?? ""} root={vault?.root ?? ""} />
        <nav className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="sep">›</span>}
              {i === crumbs.length - 1 ? c.replace(/\.md$/i, "") : c}
            </span>
          ))}
        </nav>
        <span className="spacer" />
        {/* Before the folders exist the one thing to do is create them; afterwards, open today's journal. */}
        {preset ? (
          <button className="btn ghost small" onClick={() => void openTodayJournal()} title="오늘 날짜 업무일지 열기 (Ctrl+Shift+D)">
            오늘 업무일지
          </button>
        ) : (
          <button
            className="btn ghost small"
            onClick={() => void useApp.getState().applyPreset()}
            title="업무일지·아이디어·조사자료 폴더와 템플릿을 만듭니다"
          >
            기본 구조 만들기
          </button>
        )}
        <button className="btn ghost small" onClick={() => setModal("quickMemo")} title="Ctrl+Shift+N">
          빠른 메모
        </button>
        <button className="icon-btn" title="명령 팔레트 (Ctrl+P)" onClick={() => setModal("palette")}>
          ⌘
        </button>
        <button className="icon-btn" title="설정 (Ctrl+,)" onClick={() => setModal("settings")}>
          ⚙
        </button>
        <button
          className="icon-btn"
          title={rightOpen ? "오른쪽 패널 닫기 (Ctrl+Shift+\\)" : "오른쪽 패널 열기 (Ctrl+Shift+\\)"}
          aria-label="오른쪽 패널"
          aria-pressed={rightOpen}
          onClick={() => setPanels({ rightOpen: !rightOpen })}
        >
          <PanelIcon side="right" open={rightOpen} />
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
                  업무일지·아이디어·조사자료 폴더와 템플릿이 필요하면{" "}
                  <button className="link-btn" onClick={() => void useApp.getState().applyPreset()}>
                    기본 구조 만들기
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
      <MarkdownHelp />
      <VersionView />
      <ConfirmDialog />
      <AiSendConfirm />
      <AiPreview />
    </div>
  );
}
