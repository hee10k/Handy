import React from "react";
import ReactDOM from "react-dom/client";
import Composer from "./Composer";

// The composer runs in its own always-on-top webview window (label "composer"),
// separate from the settings window and the recording overlay.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Composer />
  </React.StrictMode>,
);