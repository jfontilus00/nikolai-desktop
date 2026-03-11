import { invoke } from "@tauri-apps/api/tauri";
import { ollamaHealth } from "./ollamaHealth";
import { llmQueue } from "./llmQueue";

// ── Timeout Helper ────────────────────────────────────────────────────────────
// Wraps a promise with a timeout to prevent hanging requests.

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("LLM request timeout")), ms)
    )
  ]);
}

export type OllamaMsg = {
  role: "system" | "user" | "assistant";
  content: string;
};

function isTauri() {
  return typeof window !== "undefined" && !!(window as any).__TAURI_IPC__;
}

function norm(baseUrl: string) {
  const s = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `http://${s}`;
}

export async function ollamaChat(opts: {
  baseUrl: string;
  model: string;
  messages: OllamaMsg[];
  signal: AbortSignal;
}): Promise<string> {
  const base = norm(opts.baseUrl);
  if (!base) throw new Error("Ollama base URL is empty.");

  // ── Model Fallback ──────────────────────────────────────────────────────────
  // Resolve best available model using health monitor fallback chain.
  const model = await ollamaHealth.resolveModel(opts.model);

  const body = {
    model: model,
    messages: opts.messages,
    stream: false,
  };

  // ── LLM Request Queue ──────────────────────────────────────────────────────
  // Wrap request to prevent concurrent overload.
  return llmQueue.run(async () => {
    // ── LLM Request Timeout ──────────────────────────────────────────────────
    // Prevent hanging requests with 30 second timeout.
    const request = (async () => {
      // ✅ Tauri path (MSI/EXE safe)
      if (isTauri()) {
        const out: any = await invoke("ollama_chat_once", { baseUrl: base, body });
        const text =
          out?.message?.content ??
          out?.response ??
          out?.output ??
          "";
        return String(text || "");
      }

      // Browser fallback
      const r = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`Ollama chat failed (${r.status}): ${t}`);
      }

      const j: any = await r.json();
      return String(j?.message?.content ?? j?.response ?? "");
    })();

    return withTimeout(request, 30000);
  });
}
