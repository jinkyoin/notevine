import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useApp } from "./store";
import { useAi } from "./aiStore";
import "pretendard/dist/web/variable/pretendardvariable.css";
import { api } from "./api";

// Dev builds expose the stores so automated UI tests can drive actions that go
// through native dialogs (e.g. picking a vault folder).
if (import.meta.env.DEV) {
  Object.assign(window, { __notevine: useApp, __notevineAi: useAi, __notevineApi: api });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
