import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { appWindow } from "@tauri-apps/api/window";
import { saveAgentRunState } from "./lib/agentic";
import { ollamaHealth } from "./lib/ollamaHealth";

// ── Ollama Health Monitor ─────────────────────────────────────────────────────
// Starts monitoring Ollama server health on app startup.
// Emits status change events for UI updates.

ollamaHealth.start();

ollamaHealth.addEventListener("statuschange", (e) => {
  const status = (e as CustomEvent).detail;
  console.log("[nikolai] Ollama status:", status);
});

// ── Graceful Shutdown Hook ────────────────────────────────────────────────────
// Persists agent state before the window closes to allow recovery on restart.
// Hook is registered before React root creation to ensure it's set up early.

appWindow.onCloseRequested(async () => {
  console.log("[nikolai] graceful shutdown starting");

  try {
    // Mark active run as interrupted so it can be recovered on restart
    saveAgentRunState({ status: "interrupted" });
  } catch (err) {
    // Shutdown persistence must never throw — log and continue
    console.warn("[nikolai] shutdown persistence failed", err);
  }

  // Give persistence operations time to complete (localStorage writes are sync,
  // but this allows any pending async operations to finish)
  await new Promise(resolve => setTimeout(resolve, 300));

  console.log("[nikolai] shutdown complete");
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
