// ── Usage Log ─────────────────────────────────────────────────────────────────
//
// Persists AI usage events to localStorage for cost tracking.
//
// Limits:
//   MAX_ENTRIES — oldest entries are dropped when exceeded (ring-buffer)

export interface UsageEntry {
  timestamp: number;
  runId?: string;
  type: "chat" | "agent";
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  estimatedTokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

const STORAGE_KEY = "nikolai.usageLog.v1";
const MAX_ENTRIES = 10000;

/**
 * Append a usage entry to the log.
 * Automatically trims oldest entries if MAX_ENTRIES exceeded.
 */
export function logUsage(entry: UsageEntry): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: UsageEntry[] = raw ? JSON.parse(raw) : [];

    list.push(entry);

    if (list.length > MAX_ENTRIES) {
      list.splice(0, list.length - MAX_ENTRIES);
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("[usageLog] failed to persist usage", err);
  }
}

/**
 * Read all stored entries (oldest first).
 */
export function getUsageLog(): UsageEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Clear the entire log from localStorage.
 */
export function clearUsageLog(): void {
  localStorage.removeItem(STORAGE_KEY);
}
