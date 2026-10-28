import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useApp } from "./store";

// Dev builds expose the store so automated UI tests can drive actions that go
// through native dialogs (e.g. picking a vault folder).
if (import.meta.env.DEV) (window as unknown as { __notevine: typeof useApp }).__notevine = useApp;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
