import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { listenForInstall, registerServiceWorker } from "./pwa";
import "./index.css";

listenForInstall();
// the dev server has no sw.js and must not be cached
if (import.meta.env.PROD) registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
