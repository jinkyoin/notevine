import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { applyTheme, useApp } from "./store";
import { registerAppCommands } from "./appCommands";
import { StartScreen } from "./components/StartScreen";
import { MainLayout } from "./components/MainLayout";
import { Toasts } from "./components/Toasts";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { createQuit } from "./lib/quit";
import LockGate from "./lock/LockGate";
import { useLock, whenUnlocked } from "./lock/lockStore";
import { tx } from "./i18n";
import "./App.css";

export default function App() {
  const vault = useApp((s) => s.vault);
  const adding = useApp((s) => s.adding);

  useEffect(() => {
    applyTheme("system");
    return registerAppCommands();
  }, []);

  // Save the open note before the window closes; it always becomes a history version (FR-HIS-02).
  // With the tray on, closing only hides the window (FR-PRS-08); [종료] in the tray quits.
  useEffect(() => {
    const win = getCurrentWindow();
    const bringForward = async () => {
      await win.unminimize();
      await win.show();
      await win.setFocus();
    };
    const quit = createQuit({
      flush: () => useApp.getState().flushEditor(true),
      locked: () => useLock.getState().status?.locked === true,
      // The window may be hidden in the tray; if it can't be shown the question still waits.
      confirmDiscard: async () => {
        await bringForward().catch(() => {});
        return useApp
          .getState()
          .ask(tx("종료"), tx("저장하지 못한 편집이 있습니다. 저장하지 않고 종료할까요?"), tx("저장하지 않고 종료"), { focusCancel: true });
      },
      holdLocked: async () => {
        useLock.setState({ quitHeld: true });
        await bringForward().catch(() => {});
      },
      destroy: () => win.destroy(),
    });
    const unlisten = win.onCloseRequested(async (e) => {
      e.preventDefault();
      const tray = await api.appSettings().then((s) => s.tray).catch(() => false);
      if (!tray) return void (await quit());
      await useApp.getState().flushEditor(true).catch(() => {});
      await win.hide();
    });
    const unquit = listen("app-quit", () => void quit());
    return () => {
      unlisten.then((f) => f());
      unquit.then((f) => f());
    };
  }, []);

  // A note opened from Explorer, at the start or while already running (FR-VLT-10).
  useEffect(() => {
    // While the app is locked the file waits.
    const openPending = () =>
      whenUnlocked(
        "open",
        () =>
          void api
            .takeOpenedFile()
            .then((path) => (path ? useApp.getState().openFileFromOs(path) : undefined))
            .catch(() => {}),
      );
    const unlisten = listen("open-file", () => openPending());
    openPending();
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <LockGate>
      {/* Keyed by folder: notes with the same path in two folders must not share an editor (FR-VLT-07). */}
      {vault ? <MainLayout key={vault.root.toLowerCase()} /> : <StartScreen />}
      {/* "노트 폴더 더 열기" (FR-VLT-07): the start screen over the open folder, which stays until one is chosen. */}
      {vault && adding && (
        <div className="start-overlay">
          <StartScreen adding />
        </div>
      )}
      <ConfirmDialog />
      <Toasts />
    </LockGate>
  );
}
