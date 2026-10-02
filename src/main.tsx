import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initTheme } from "./lib/theme";
import "./index.css";

initTheme();

// Block the webview's default context menu except in text fields.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only hook so automated UI tests can drive imports without native file dialogs.
if (import.meta.env.DEV) {
  void Promise.all([
    import("./features/media-bin/importer"),
    import("./store/project"),
    import("./store/ui"),
    import("./store/runtime"),
    import("./features/export/jobs"),
    import("./features/enhance/enhance"),
  ]).then(([importer, project, ui, runtime, jobs, enhance]) => {
    (window as unknown as Record<string, unknown>).__beaver = { importer, project, ui, runtime, jobs, enhance };
  });
}
