import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import type { OllamaMsg } from "./ollamaChat";
import { ollamaHealth } from "./ollamaHealth";
import { llmQueue } from "./llmQueue";

/**
 * Thrown when the safety timeout fires and Ollama has not
 * produced a complete response. Named class so it can be
 * caught specifically in the parse retry loop without
 * being confused with real LLM errors.
 */
export class StreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamTimeoutError";
  }
}

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
type DoneEvt  = { id: string; aborted: boolean; prompt_tokens?: number; output_tokens?: number };
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
}): Promise<{ promptTokens: number; completionTokens: number }> {
  const base = norm(opts.baseUrl);
  if (!base) throw new Error("Ollama base URL is empty.");

  console.log("[OLLAMA] stream chat start", {
    baseUrl: base,
    model: opts.model,
    messageCount: opts.messages.length
  });

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

        console.log("[OLLAMA] Tauri stream start", { id, baseUrl: base });

        const unToken = await listen<TokenEvt>("ollama://token", (e) => {
          const p = e.payload;
          if (p?.id === id && p.token) {
            console.log("[OLLAMA] token received", p.token.slice(0, 50));
            opts.onToken(String(p.token));
          }
        });

        // Hoist resolveDone so timeout handler can force-resolve
        let resolveDone!: (promptTokens?: number, outputTokens?: number) => void;
        const donePromise = new Promise<{ promptTokens?: number; outputTokens?: number } | void>((resolve) => {
          resolveDone = resolve;
        });

        // Listen for done event — fires resolveDone when Ollama sends final token
        const unDone = await listen<DoneEvt>("ollama://done", (e) => {
          if (e.payload?.id === id) {
            console.log("[OLLAMA] done event received", {
              id,
              prompt_tokens: e.payload.prompt_tokens,
              output_tokens: e.payload.output_tokens
            });
            unDone();
            resolveDone(e.payload.prompt_tokens, e.payload.output_tokens);
          }
        });

        const unErr = await listen<ErrEvt>("ollama://error", (e) => {
          if (e.payload?.id === id) {
            unErr();
            // Reject so timeout handler knows stream failed
          }
        });

        const onAbort = async () => {
          try { await invoke("ollama_chat_abort", { id }); } catch { /* ignore */ }
        };

        if (opts.signal.aborted) await onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });

        try {
          await invoke("ollama_chat_stream", { id, baseUrl: base, body });

          const STREAM_TIMEOUT_MS = 20_000;

          // Race between normal completion and safety timeout.
          // IMPORTANT: on timeout, we FORCE-RESOLVE donePromise so that
          // finalizeStreaming() always runs and buffers are always cleared.
          const tokenResult = await Promise.race([
            donePromise,
            new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), STREAM_TIMEOUT_MS)
            ),
          ]);

          if (tokenResult === undefined) {
            console.warn(
              "[STREAM] safety timeout reached after " + STREAM_TIMEOUT_MS + "ms. " +
              "Ollama may have dropped the final token. Force-resolving stream."
            );
            // Force-resolve so finalizeStreaming runs and buffers are cleared
            resolveDone();  // ← THIS IS THE FIX

            // Throw named error so parse retry loop can identify timeout
            // vs genuine JSON parse failure and exit immediately.
            throw new StreamTimeoutError(
              "Ollama stream timed out after " + STREAM_TIMEOUT_MS + "ms"
            );
          }

          // Log token counts if available from Ollama
          if (tokenResult && tokenResult.prompt_tokens !== undefined) {
            console.log(
              `[OLLAMA] tokens: prompt=${tokenResult.prompt_tokens}, output=${tokenResult.output_tokens}`
            );
            return {
              promptTokens: tokenResult.prompt_tokens,
              completionTokens: tokenResult.output_tokens,
            };
          }

          // Fallback: no token data available
          return { promptTokens: 0, completionTokens: 0 };
        } finally {
          opts.signal.removeEventListener("abort", onAbort);  // Remove listener to prevent leak
          try { unToken(); } catch {}
        }
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

      // Track last known token counts for fallback when stream closes without done marker
      let lastKnownPromptTokens = 0;
      let lastKnownOutputTokens = 0;
      let receivedDoneMarker = false;

      while (true) {
        const { done, value } = await reader.read();
        
        // Stream closed — return last known token counts if no done marker received
        if (done) {
          if (!receivedDoneMarker) {
            console.warn("[OLLAMA] stream closed without done marker");
          }
          return {
            promptTokens: lastKnownPromptTokens,
            completionTokens: lastKnownOutputTokens
          };
        }

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
            if (j?.done) {
              receivedDoneMarker = true;
              lastKnownPromptTokens = j?.prompt_eval_count ?? 0;
              lastKnownOutputTokens = j?.eval_count ?? 0;
              console.log(
                `[OLLAMA] tokens: prompt=${lastKnownPromptTokens}, output=${lastKnownOutputTokens}`
              );
              return { promptTokens: lastKnownPromptTokens, completionTokens: lastKnownOutputTokens };
            }
          } catch { /* ignore parse errors */ }
        }
      }
    })();

    return withTimeout(streamTask, 60000);
  });
}