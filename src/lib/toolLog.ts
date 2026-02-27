// ── Tool Log ─────────────────────────────────────────────────────────────────
//
// Persists tool call history to localStorage for the Tools panel to display.
//
// Limits:
//   MAX_ITEMS       — oldest entries are dropped when exceeded (ring-buffer)
//   MAX_TOTAL_CHARS — if serialized JSON exceeds this, oldest half is pruned
//   QuotaExceededError — caught explicitly; log is trimmed and retried, then
//                        cleared entirely as a last resort (never throws to caller)

const STORAGE_KEY    = "nikolai.tool.log.v2";
const MAX_ITEMS      = 120;
const MAX_TOTAL_CHARS = 200_000; // ~200KB — well within typical 5MB localStorage quota

export type ToolLogEntry = {
  id: string;
  ts: number;
  tool: string;
  args: any;
  ok: boolean;
  result?: any;
  error?: string;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function loadRaw(): ToolLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ToolLogEntry[];
  } catch {
    return [];
  }
}

function persistSafe(entries: ToolLogEntry[]): void {
  // Attempt 1: write as-is
  try {
    const json = JSON.stringify(entries);

    // Pre-check size before hitting the quota wall
    if (json.length > MAX_TOTAL_CHARS) {
      // Drop oldest half and retry
      const half = entries.slice(Math.floor(entries.length / 2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(half));
      return;
    }

    localStorage.setItem(STORAGE_KEY, json);
  } catch (e: any) {
    const isQuota =
      e?.name === "QuotaExceededError" ||
      e?.code === 22 || // legacy browsers
      String(e).toLowerCase().includes("quota");

    if (isQuota) {
      // Attempt 2: drop oldest half and retry
      try {
        const current = loadRaw();
        const half    = current.slice(Math.floor(current.length / 2));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(half));
        return;
      } catch {
        // Attempt 3: clear entirely — better to lose history than crash
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* give up */ }
      }
    }
    // Non-quota errors (private browsing etc.) — fail silently
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Append a tool call entry. Automatically trims oldest entries if limits exceeded. */
export function appendToolLog(entry: ToolLogEntry): void {
  const entries = loadRaw();
  entries.push(entry);

  // Ring-buffer: keep only the latest MAX_ITEMS
  const trimmed = entries.length > MAX_ITEMS
    ? entries.slice(entries.length - MAX_ITEMS)
    : entries;

  persistSafe(trimmed);
}

/** Read all stored entries (newest last). */
export function getToolLog(): ToolLogEntry[] {
  return loadRaw();
}

/** Clear the entire log from localStorage. */
export function clearToolLog(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}