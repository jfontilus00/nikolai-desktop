import { invoke } from "@tauri-apps/api/tauri";

function isTauri() {
  return typeof window !== "undefined" && (window as any).__TAURI__ != null;
}

// Fallback key if OS keychain fails (still lets you work)
const FALLBACK_PREFIX = "nikolai.secrets.fallback.";

export async function secretGet(key: string): Promise<string | null> {
  const k = String(key || "").trim();
  if (!k) return null;

  // Prefer OS keychain via Tauri
  if (isTauri()) {
    try {
      const v = await invoke<string | null>("secret_get", { key: k });
      if (typeof v === "string") return v;
      return null;
    } catch {
      // fallback below
    }
  }

  try {
    const v = localStorage.getItem(FALLBACK_PREFIX + k);
    return v ? v : null;
  } catch {
    return null;
  }
}

export async function secretSet(key: string, value: string): Promise<void> {
  const k = String(key || "").trim();
  if (!k) throw new Error("secretSet: key is empty");

  const v = String(value ?? "");

  if (isTauri()) {
    try {
      await invoke("secret_set", { key: k, value: v });
      // If we successfully stored securely, remove fallback copy
      try {
        localStorage.removeItem(FALLBACK_PREFIX + k);
      } catch {}
      return;
    } catch {
      // fallback below
    }
  }

  // fallback
  try {
    localStorage.setItem(FALLBACK_PREFIX + k, v);
  } catch {
    // ignore
  }
}

export async function secretDelete(key: string): Promise<void> {
  const k = String(key || "").trim();
  if (!k) return;

  if (isTauri()) {
    try {
      await invoke("secret_delete", { key: k });
    } catch {
      // ignore
    }
  }

  try {
    localStorage.removeItem(FALLBACK_PREFIX + k);
  } catch {
    // ignore
  }
}
