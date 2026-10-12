// Fixture host for the automatic bilingual input settings panel. Playwright
// installs a Tauri IPC mock before this module runs (see tests/auto-input.spec.ts).
import React from "react";
import ReactDOM from "react-dom/client";
import "@/i18n";
import AutoInputSettings from "@/components/settings/transform/AutoInputSettings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AutoInputSettings />,
);
