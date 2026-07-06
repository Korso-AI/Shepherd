import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { SelfHostApp } from "./selfhost.js";

/**
 * SPA mount point for the self-host app build. Bundles the stylesheet (the
 * standalone build ships its own CSS, unlike the `.` lib export which leaves
 * styling opt-in) and mounts the token-gated {@link SelfHostApp} at #root.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SelfHostApp />
  </StrictMode>,
);
