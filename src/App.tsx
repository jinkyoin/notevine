import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { applyTheme, useApp } from "./store";
import { registerAppCommands } from "./appCommands";
import { StartScreen } from "./components/StartScreen";
import { MainLayout } from "./components/MainLayout";
import { Toasts } from "./components/Toasts";
import "./App.css";

export default function App() {
  const vault = useApp((s) => s.vault);

  useEffect(() => {
    applyTheme("system");
    return registerAppCommands();
  }, []);

  // Save the open note before the window closes; it always becomes a history version (FR-HIS-02).
  // With the tray on, closing only hides the window (FR-PRS-08); [종료] in the tray quits.
  useEffect(() => {
    const win = getCurrentWindow();
    const quit = async () => {
      try {
        await useApp.getState().flushEditor(true);
      } finally {
        await win.destroy();
      }
    };
    const unlisten = win.onCloseRequested(async (e) => {
      e.preventDefault();
      const tray = await api.appSettings().then((s) => s.tray).catch(() => false);
      if (!tray) return quit();
      await useApp.getState().flushEditor(true).catch(() => {});
      await win.hide();
    });
    const unquit = listen("app-quit", () => void quit());
    return () => {
      unlisten.then((f) => f());
      unquit.then((f) => f());
    };
  }, []);

  return (
    <>
      {vault ? <MainLayout /> : <StartScreen />}
      <Toasts />
    </>
  );
}
