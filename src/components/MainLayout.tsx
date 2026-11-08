// SCR-02 메인 화면: 상단바 + 왼쪽 사이드바(파일·검색·아이디어) + 편집기 + 오른쪽 패널(속성·백링크·히스토리).
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "../store";
import { dispatchKey, setKeyOverrides } from "../commands";
import { api } from "../api";
import { Explorer } from "./Explorer";
import { Editor } from "./Editor";
import { TabBar } from "./TabBar";
import { Backlinks } from "./Backlinks";
import { RelocateDialog } from "./RelocateDialog";
import { SearchPanel } from "./SearchPanel";
import { QuickOpen } from "./QuickOpen";
import { PropertiesPanel } from "./PropertiesPanel";
import { HistoryPanel } from "./HistoryPanel";
import { VersionView } from "./VersionView";
import { FolderView } from "./FolderView";
import { SplitPane } from "./SplitPane";
import { DeletedNotes } from "./DeletedNotes";
import { MarkdownHelp } from "./MarkdownHelp";
import { UserManual } from "./UserManual";
import { WebClip } from "./WebClip";
// Not in the PdfView chunk: loaded later, it would come after App.css and win over its rules.
import "pdfjs-dist/web/pdf_viewer.css";
import { CanvasView } from "./CanvasView";
import { PanelResizer } from "./PanelResizer";
import { PluginPanels } from "./PluginPanels";
import { usePluginHost } from "../plugins";
import { checkForUpdate } from "../updates";
import { IdeaBoard } from "./IdeaBoard";
import { CommandPalette } from "./CommandPalette";
import { QuickMemo } from "./QuickMemo";
import { TemplatePicker } from "./TemplatePicker";
import { Settings } from "./Settings";
import { AiPanel } from "./AiPanel";
import { AiPreview, AiSendConfirm } from "./AiDialogs";
import { AiEdits } from "./AiEdits";

import { tx } from "../i18n";

// pdf.js is large and most sessions never open a PDF.
const PdfView = lazy(() => import("./PdfView").then((m) => ({ default: m.PdfView })));
/** The vault's `.app/custom.css`, last in the page so it wins over the app's own styles. */
function applyUserCss(text: string) {
  let el = document.getElementById("user-css");
  if (!text) return void el?.remove();
  if (!el) {
    el = document.createElement("style");
    el.id = "user-css";
  }
  document.head.appendChild(el);
  if (el.textContent !== text) el.textContent = text;
}

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
      <button className="vault-name" title={tx("{0}\n눌러서 노트 폴더 바꾸기", root)} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {name} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => run(() => useApp.getState().closeVault())}>
            {tx("노트 폴더 바꾸기…")}
          </button>
          <button role="menuitem" onClick={() => run(() => void revealItemInDir(root).catch(() => {}))}>
            {tx("탐색기에서 노트 폴더 열기")}
          </button>
        </div>
      )}
    </div>
  );
}

let updateChecked = false;

export function MainLayout() {
  const vault = useApp((s) => s.vault);
  const openPath = useApp((s) => s.openPath);
  const tableView = useApp((s) => s.tableView);
  const pdfView = useApp((s) => s.pdfView);
  const canvasView = useApp((s) => s.canvasView);
  const splitPath = useApp((s) => s.splitPath);
  const sidebarTab = useApp((s) => s.sidebarTab);
  const preset = useApp((s) => s.config.preset_enabled);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const canBack = useApp((s) => s.back.length > 0);
  const canForward = useApp((s) => s.forward.length > 0);
  const { setSidebarTab, focusSearch, setPanels, setModal, goBack, goForward } = useApp.getState();

  // All shortcuts go through the command registry (FR-EXT-01).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => void dispatchKey(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The user's shortcuts and CSS (FR-UI-05). The CSS is read again whenever the window
  // comes back to the front, so saving it in another editor shows at once.
  const keybindings = useApp((s) => s.config.keybindings);
  const customCss = useApp((s) => s.trust.custom_css);
  useEffect(() => setKeyOverrides(keybindings), [keybindings]);
  useEffect(() => {
    if (!customCss) return applyUserCss("");
    const load = () => void api.customCss(false).then(([, text]) => applyUserCss(text)).catch(() => {});
    load();
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("focus", load);
      applyUserCss("");
    };
  }, [customCss, vault?.root]);

  // Ctrl+Alt+N from any program (FR-PRS-08): the backend brings the window forward.
  useEffect(() => {
    const off = listen("quick-memo", () => {
      const { modal, setModal } = useApp.getState();
      if (modal === null || modal === "palette") setModal("quickMemo");
    });
    return () => void off.then((f) => f());
  }, []);

  // Git backup on a timer (settings → 백업), only when the vault is a repository with changes.
  const backupMinutes = useApp((s) => s.trust.backup_minutes);
  useEffect(() => {
    if (!backupMinutes) return;
    const id = window.setInterval(() => {
      void api
        .backupStatus()
        .then((s) => s.repo && s.trusted && (s.changed > 0 || s.ahead > 0) && useApp.getState().backupNow(true))
        .catch(() => {});
    }, backupMinutes * 60_000);
    return () => window.clearInterval(id);
  }, [backupMinutes, vault?.root]);

  // A new version, once per run, only for someone who turned this on (settings → 정보).
  useEffect(() => {
    if (import.meta.env.DEV || updateChecked) return;
    updateChecked = true;
    void api
      .appSettings()
      .then((s) => (s.update_check ? checkForUpdate(true) : undefined))
      .catch(() => {});
  }, []);

  // Plugins of this vault (FR-EXT-02), run while it is open.
  usePluginHost();

  const crumbs = openPath ? openPath.split("/") : [];

  return (
    <div className="main">
      <header className="topbar">
        <button
          className="icon-btn"
          title={leftOpen ? tx("왼쪽 사이드바 닫기 (Ctrl+\\)") : tx("왼쪽 사이드바 열기 (Ctrl+\\)")}
          aria-label={tx("왼쪽 사이드바")}
          aria-pressed={leftOpen}
          onClick={() => setPanels({ leftOpen: !leftOpen })}
        >
          <PanelIcon side="left" open={leftOpen} />
        </button>
        <button className="icon-btn" title={tx("이전 노트 (Alt+←)")} disabled={!canBack} onClick={goBack}>
          ‹
        </button>
        <button className="icon-btn" title={tx("다음 노트 (Alt+→)")} disabled={!canForward} onClick={goForward}>
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
        {/* Until the folders exist, offer to create them. Today's journal is Ctrl+Shift+D or the palette. */}
        {!preset && (
          <button
            className="btn ghost small"
            onClick={() => void useApp.getState().applyPreset()}
            title={tx("PARA(프로젝트·영역·자료·보관) 폴더와 템플릿을 만듭니다")}
          >
            {tx("기본 구조 만들기")}
          </button>
        )}
        <button className="btn ghost small" onClick={() => setModal("quickMemo")} title={tx("Ctrl+Shift+N · 다른 프로그램을 쓰는 중에는 Ctrl+Alt+N")}>
          {tx("빠른 메모")}
        </button>
        <button className="icon-btn" title={tx("명령 팔레트 (Ctrl+P)")} onClick={() => setModal("palette")}>
          ⌘
        </button>
        <button className="icon-btn" title={tx("설정 (Ctrl+,)")} onClick={() => setModal("settings")}>
          ⚙
        </button>
        <button
          className="icon-btn"
          title={rightOpen ? tx("오른쪽 패널 닫기 (Ctrl+Shift+\\)") : tx("오른쪽 패널 열기 (Ctrl+Shift+\\)")}
          aria-label={tx("오른쪽 패널")}
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
                {tx("파일")}
              </button>
              <button role="tab" className={sidebarTab === "search" ? "on" : ""} onClick={focusSearch} title="Ctrl+Shift+F">
                {tx("검색")}
              </button>
              {preset && (
                <button role="tab" className={sidebarTab === "ideas" ? "on" : ""} onClick={() => setSidebarTab("ideas")}>
                  {tx("아이디어")}
                </button>
              )}
            </div>
            {sidebarTab === "search" ? <SearchPanel /> : sidebarTab === "ideas" && preset ? <IdeaBoard /> : <Explorer />}
            <PanelResizer side="left" />
          </aside>
        )}
        <main className="center">
          <div className="pane">
            <TabBar />
            {canvasView ? (
              <CanvasView key={canvasView} path={canvasView} />
            ) : pdfView ? (
              <Suspense fallback={null}>
                <PdfView key={pdfView.path} path={pdfView.path} page={pdfView.page} seq={pdfView.seq} />
              </Suspense>
            ) : tableView !== null ? (
              <FolderView key={tableView} folder={tableView} />
            ) : openPath ? (
              <Editor key={openPath} path={openPath} />
            ) : (
              <div className="empty">
                <p>{tx("열린 노트가 없습니다.")}</p>
                <button className="btn primary" onClick={() => setModal("template")}>
                  {tx("새 노트 (Ctrl+N)")}
                </button>
                {!preset && (
                  <p className="muted small">
                    {tx("PARA(프로젝트·영역·자료·보관) 폴더와 템플릿이 필요하면")}{" "}
                    <button className="link-btn" onClick={() => void useApp.getState().applyPreset()}>
                      {tx("기본 구조 만들기")}
                    </button>
                  </p>
                )}
              </div>
            )}
          </div>
          {splitPath && <SplitPane path={splitPath} />}
        </main>
        {rightOpen && (
          <aside className="rightpanel">
            <PanelResizer side="right" />
            {/* Note info on top, the AI assistant always below it (SCR-18). */}
            <div className="info-scroll">
              {openPath && <PropertiesPanel />}
              <Backlinks />
              <HistoryPanel />
              <PluginPanels />
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
      <UserManual />
      <WebClip />
      <VersionView />
      <AiSendConfirm />
      <AiPreview />
      <AiEdits />
    </div>
  );
}
