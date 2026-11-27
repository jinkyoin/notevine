import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useApp } from "./store";
import { useAi } from "./aiStore";
import "pretendard/dist/web/variable/pretendardvariable.css";
import { api } from "./api";
import { installKeyGuard } from "./lock/keyGuard";
import { applyNoteZoom, loadNoteZoom } from "./lib/noteZoom";

// Dev builds expose the stores so automated UI tests can drive actions that go
// through native dialogs (e.g. picking a vault folder).
if (import.meta.env.DEV) {
  Object.assign(window, { __notevine: useApp, __notevineAi: useAi, __notevineApi: api });
}

// Before anything else listens: a locked app hears no keys (NFR-SEC-04).
installKeyGuard();
// The note text size chosen with Ctrl+wheel last time.
applyNoteZoom(loadNoteZoom());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
