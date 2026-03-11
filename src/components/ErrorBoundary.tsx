import React from "react";
import { copyText } from "../lib/clipboard";
import { writeTextFile, BaseDirectory } from "@tauri-apps/api/fs";

type State = {
  hasError: boolean;
  message: string;
  stack?: string;
};

// ── Crash Log Helper ──────────────────────────────────────────────────────────
// Writes crash information to disk for later analysis.
// Never throws — errors are silently logged to console.

async function writeCrashLog(message: string, stack?: string) {
  const timestamp = new Date().toISOString();
  const entry =
    `[${timestamp}] CRASH\n` +
    `Message: ${message}\n` +
    `Stack:\n${stack ?? "none"}\n\n`;

  try {
    await writeTextFile(
      "nikolai-crash.log",
      entry,
      {
        dir: BaseDirectory.AppLog,
        append: true
      }
    );
  } catch (err) {
    // Crash handler must never throw — log to console and continue
    console.warn("[nikolai] failed to write crash log", err);
  }
}

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(err: any): State {
    return { hasError: true, message: err?.message || String(err), stack: err?.stack };
  }

  componentDidCatch(err: any) {
    // keep console useful
    console.error("[ErrorBoundary]", err);

    // Write crash log to disk for later analysis
    const componentStack = err?.stack ?? err?.componentStack ?? "none";
    writeCrashLog(err?.message || String(err), componentStack);
  }

  private resetApp = () => {
    // Soft reset: clear Nikloai keys only
    try {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("nikolai."));
      for (const k of keys) localStorage.removeItem(k);
    } catch {
      // ignore
    }
    window.location.reload();
  };

  private copyDetails = async () => {
    const txt = `Nikolai Desktop crashed\n\n${this.state.message}\n\n${this.state.stack || ""}`;
    try {
      const ok = await copyText(txt);
      alert(ok ? "Copied error details." : "Copy failed. You can screenshot the error.");
    } catch {
      alert("Copy failed. You can screenshot the error.");
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="h-screen w-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="text-lg font-semibold">Something went wrong</div>
          <div className="text-sm opacity-80 mt-1">
            The app hit a runtime error. You can copy details and reset local app state safely.
          </div>

          <div className="mt-4 rounded-lg border border-white/10 bg-black/40 p-3 text-xs whitespace-pre-wrap">
            {this.state.message}
            {this.state.stack ? `\n\n${this.state.stack}` : ""}
          </div>

          <div className="mt-4 flex gap-2">
            <button
              className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
              onClick={this.copyDetails}
            >
              Copy details
            </button>
            <button
              className="px-3 py-2 rounded-md bg-amber-600 hover:bg-amber-500 text-sm font-semibold"
              onClick={this.resetApp}
              title="Clears only localStorage keys starting with nikolai."
            >
              Reset app data
            </button>
          </div>

          <div className="mt-3 text-xs opacity-60">
            Tip: If this happens often, it usually means a corrupted chat/tool log entry or a bad patch. Reset fixes it fast.
          </div>
        </div>
      </div>
    );
  }
}
