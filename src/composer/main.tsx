import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n"; // own i18next instance sharing the app locales (see i18n.ts)
import Composer from "./Composer";

// The composer runs in its own always-on-top webview window (label "composer"),
// separate from the settings window and the recording overlay.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Composer />
  </React.StrictMode>,
);