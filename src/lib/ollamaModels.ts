import { invoke } from "@tauri-apps/api/tauri";

function isTauri() {
  return typeof window !== "undefined" && !!(window as any).__TAURI_IPC__;
}

function norm(baseUrl: string) {
  const s = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `http://${s}`;
}

export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const base = norm(baseUrl);
  if (!base) throw new Error("Ollama base URL is empty.");

  // ✅ In MSI/EXE (Tauri), use Rust proxy to avoid fetch restrictions
  if (isTauri()) {
    const out: any = await invoke("ollama_tags", { baseUrl: base });
    const models = Array.isArray(out?.models) ? out.models : [];
    return models.map((m: any) => m?.name).filter(Boolean);
  }

  // Browser fallback
  const r = await fetch(`${base}/api/tags`);
  if (!r.ok) throw new Error(`GET /api/tags failed (${r.status})`);
  const j: any = await r.json();
  const models = Array.isArray(j?.models) ? j.models : [];
  return models.map((m: any) => m?.name).filter(Boolean);
}
