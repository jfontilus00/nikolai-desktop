import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import type { OllamaMsg } from "./ollamaChat";
import { ollamaHealth } from "./ollamaHealth";
import { llmQueue } from "./llmQueue";

// ── Timeout Helper ────────────────────────────────────────────────────────────
// Wraps a promise with a timeout to prevent hanging requests.

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("LLM stream timeout")), ms)
    )
  ]);
}

function isTauri() {
  return typeof window !== "undefined" && !!(window as any).__TAURI_IPC__;
}

function norm(baseUrl: string) {
  const s = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `http://${s}`;
}

type TokenEvt = { id: string; token: string };
type DoneEvt  = { id: string; aborted: boolean };
type ErrEvt   = { id: string; error: string };

// ── V3: OllamaMsg extended to carry images ─────────────────────────────────
// Ollama's /api/chat accepts an optional `images` array (base64 strings) on
// each message object. Vision models (llava, bakllava, gemma3, moondream)
// use this to see the attached images. Non-vision models ignore it silently.
export type OllamaMsgWithImages = OllamaMsg & {
  images?: string[];
};

export async function ollamaStreamChat(opts: {
  baseUrl: string;
  model: string;
  messages: OllamaMsgWithImages[];
  signal: AbortSignal;
  onToken: (t: string) => void;
}): Promise<void> {
  const base = norm(opts.baseUrl);
  if (!base) throw new Error("Ollama base URL is empty.");

  // Strip images from non-last messages to keep context small.
  // Ollama only uses images on the current turn anyway.
  const messages = opts.messages.map((m, i) => {
    const isLast = i === opts.messages.length - 1;
    if (!isLast && m.images && m.images.length > 0) {
      const { images: _drop, ...rest } = m;
      return rest;
    }
    return m;
  });

  // ── Model Fallback ──────────────────────────────────────────────────────────
  // Resolve best available model using health monitor fallback chain.
  const model = await ollamaHealth.resolveModel(opts.model);

  const body = {
    model: model,
    messages,
    stream: true,
  };

  // ── LLM Request Queue ──────────────────────────────────────────────────────
  // Wrap request to prevent concurrent overload.
  return llmQueue.run(async () => {
    // ── LLM Stream Timeout ───────────────────────────────────────────────────
    // Prevent hanging streams with 60 second timeout.
    const streamTask = (async () => {
      // ✅ Tauri path: stream via Rust + events (fix MSI/EXE fetch restrictions)
      if (isTauri()) {
        const id = `ol-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const unToken = await listen<TokenEvt>("ollama://token", (e) => {
          const p = e.payload;
          if (p?.id === id && p.token) opts.onToken(String(p.token));
        });

        const donePromise = new Promise<void>(async (resolve, reject) => {
          const unDone = await listen<DoneEvt>("ollama://done", (e) => {
            if (e.payload?.id === id) {
              unDone();
              resolve();
            }
          });

          const unErr = await listen<ErrEvt>("ollama://error", (e) => {
            if (e.payload?.id === id) {
              unErr();
              reject(new Error(String(e.payload?.error || "Unknown ollama proxy error")));
            }
          });
        });

        const onAbort = async () => {
          try { await invoke("ollama_chat_abort", { id }); } catch { /* ignore */ }
        };

        if (opts.signal.aborted) await onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });

        try {
          await invoke("ollama_chat_stream", { id, baseUrl: base, body });
          await donePromise;
        } finally {
          try { unToken(); } catch {}
        }

        return;
      }

      // Browser fallback: direct fetch streaming (NDJSON)
      const r = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`Ollama chat stream failed (${r.status}): ${t}`);
      }

      const reader = r.body?.getReader();
      if (!reader) throw new Error("No response body reader (stream unsupported).");

      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += dec.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const j: any = JSON.parse(line);
            const token = j?.message?.content ?? j?.response ?? "";
            if (token) opts.onToken(String(token));
            if (j?.done) return;
          } catch { /* ignore parse errors */ }
        }
      }
    })();

    return withTimeout(streamTask, 60000);
  });
}