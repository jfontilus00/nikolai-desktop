import { invoke } from "@tauri-apps/api/tauri";

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

  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };

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
}
