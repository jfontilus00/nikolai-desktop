// ── Ollama Health Monitor ────────────────────────────────────────────────────
//
// Monitors local Ollama server health and provides automatic model fallback.
// Emits status change events for UI updates.
//

// ── Types ─────────────────────────────────────────────────────────────────────

type OllamaStatus = "healthy" | "degraded" | "down";

interface ModelFallbackChain {
  primary: string;
  fallbacks: string[];
}

// ── Health Monitor Class ──────────────────────────────────────────────────────

class OllamaHealthMonitor extends EventTarget {

  private status: OllamaStatus = "healthy";
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;

  // Model fallback chain — tries primary first, then falls back to smaller models
  readonly chain: ModelFallbackChain = {
    primary: "qwen2.5:14b",
    fallbacks: ["qwen2.5:7b", "llama3.2:3b", "phi3:mini"]
  };

  // ── Start health monitoring ────────────────────────────────────────────────
  // Checks immediately, then every 30 seconds.
  start() {
    this.check();
    this.timer = setInterval(() => this.check(), 30000);
  }

  // ── Stop health monitoring ─────────────────────────────────────────────────
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── Check Ollama health ────────────────────────────────────────────────────
  // Calls /api/tags to verify Ollama is responding.
  // 3 consecutive failures = "down", 1-2 failures = "degraded".
  async check() {
    try {
      const res = await fetch(
        "http://127.0.0.1:11434/api/tags",
        { signal: AbortSignal.timeout(4000) }
      );

      if (!res.ok) throw new Error("non-200");

      this.consecutiveFailures = 0;
      this.setStatus("healthy");

    } catch {
      this.consecutiveFailures++;

      this.setStatus(
        this.consecutiveFailures >= 3
          ? "down"
          : "degraded"
      );
    }
  }

  // ── Resolve model with fallback ────────────────────────────────────────────
  // If preferred model is unavailable or Ollama is degraded, tries fallback chain.
  async resolveModel(preferred: string): Promise<string> {
    // If healthy, use preferred model directly
    if (this.status === "healthy") return preferred;

    try {
      const res = await fetch("http://127.0.0.1:11434/api/tags");
      const data = await res.json();

      const loaded = data.models?.map((m: any) => m.name) ?? [];

      // Build chain: preferred + fallbacks
      const chain = [preferred, ...this.chain.fallbacks];

      // Return first available model in chain
      return chain.find(m => loaded.includes(m)) ?? preferred;

    } catch {
      // If we can't check, just return preferred and let caller handle error
      return preferred;
    }
  }

  // ── Get current status ─────────────────────────────────────────────────────
  getStatus(): OllamaStatus {
    return this.status;
  }

  // ── Set status and dispatch event ──────────────────────────────────────────
  private setStatus(s: OllamaStatus) {
    if (this.status !== s) {
      this.status = s;

      // Dispatch event for UI components to react
      this.dispatchEvent(
        new CustomEvent("statuschange", { detail: s })
      );

      console.log(`[ollama-health] status changed: ${s}`);
    }
  }
}

// ── Export singleton instance ────────────────────────────────────────────────

export const ollamaHealth = new OllamaHealthMonitor();
