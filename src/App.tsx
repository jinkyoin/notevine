import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (e) => {
      e.preventDefault();
      try {
        await useApp.getState().flushEditor(true);
      } finally {
        await win.destroy();
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <>
      {vault ? <MainLayout /> : <StartScreen />}
      <Toasts />
    </>
  );
}
