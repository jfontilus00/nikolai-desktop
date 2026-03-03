import { invoke } from "@tauri-apps/api/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

export type McpStdioConfig = {
  command: string;
  args: string[];
  cwd?: string | null;
};

export type McpStatus = {
  connected: boolean;
  command?: string;
  cwd?: string | null;
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: any;
};

export type McpStatePayload =
  | { state: "disconnected"; message?: string; ts: number }
  | { state: "connecting"; message?: string; ts: number }
  | { state: "connected"; message?: string; ts: number }
  | { state: "error"; message: string; ts: number };

type McpStateValue = McpStatePayload["state"];

let autoReconnectCb: (() => void) | null = null;
export function setAutoReconnectCallback(cb: (() => void) | null) {
  autoReconnectCb = cb;
}

function isTauri() {
  return typeof window !== "undefined" && (window as any).__TAURI__ != null;
}

export async function mcpStatus(): Promise<McpStatus> {
  if (!isTauri()) return { connected: false };
  return await invoke("mcp_status");
}
export async function mcpConnect(cfg: McpStdioConfig): Promise<McpStatus> {
  if (!isTauri()) throw new Error("Not running in Tauri");
  return await invoke("mcp_connect", { cfg });
}
export async function mcpDisconnect(): Promise<McpStatus> {
  if (!isTauri()) return { connected: false };
  return await invoke("mcp_disconnect");
}
export async function mcpListTools(): Promise<McpTool[]> {
  if (!isTauri()) throw new Error("Not running in Tauri");
  return await invoke("mcp_list_tools");
}

// ── mcpCallTool — now accepts an optional AbortSignal ────────────────────────
//
// Pre-flight: rejects immediately if signal is already aborted before invoke.
// In-flight:  races the Tauri invoke against the signal — JS chain cleans up
//             as soon as the signal fires, without waiting for the full timeout.
//
// Caveat: the Rust command handler always runs to completion — Tauri does not
// support JS-side cancellation of in-flight IPC calls. What this prevents is
// promise chains accumulating and hanging on the JS side over long sessions.
//
export async function mcpCallTool(name: string, args: any, signal?: AbortSignal): Promise<any> {
  if (!isTauri()) throw new Error("Not running in Tauri");

  // Pre-flight check — don't even start if already cancelled
  if (signal?.aborted) {
    throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  }

  const invokePromise = invoke("mcp_call_tool", { name, args });

  // No signal — return invoke directly (same behaviour as before)
  if (!signal) return invokePromise;

  // Race invoke against abort signal
  return new Promise<any>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    invokePromise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

export async function listenMcpState(cb: (payload: McpStatePayload) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return await listen("mcp://state", (event) => cb(event.payload as any));
}

// ── Store ─────────────────────────────────────────────────────────────────────

type StoreSnapshot = {
  mcpState: McpStateValue;
  loading: boolean;
  toolsLoading: boolean;
  error: string | null;
  tools: string[];
  toolsRaw: McpTool[];
  lastToolsFetchAt: number | null;
  connectedAt: number | null;
  disconnectedAt: number | null;
};

const initialSnapshot: StoreSnapshot = {
  mcpState: "disconnected",
  loading: false,
  toolsLoading: false,
  error: null,
  tools: [],
  toolsRaw: [],
  lastToolsFetchAt: null,
  connectedAt: null,
  disconnectedAt: null,
};

let store: StoreSnapshot = { ...initialSnapshot };
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const fn of listeners) { try { fn(); } catch { /* ignore */ } }
}
function setStore(partial: Partial<StoreSnapshot>) {
  store = { ...store, ...partial };
  notifyListeners();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot(): StoreSnapshot { return store; }
function getServerSnapshot(): StoreSnapshot { return initialSnapshot; }

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: any;
  const tp = new Promise<T>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try { return await Promise.race([p, tp]); } finally { clearTimeout(t); }
}

function normalizeToolsResult(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (res?.tools && Array.isArray(res.tools)) return res.tools;
  if (res?.result?.tools && Array.isArray(res.result.tools)) return res.result.tools;
  if (res?.result && Array.isArray(res.result)) return res.result;
  return [];
}

function toolNamesFrom(raw: any[]): string[] {
  return raw
    .map((t) => (t && typeof t === "object" && t.name ? String(t.name) : String(t)))
    .filter((x) => x && x !== "[object Object]");
}

let initPromise: Promise<void> | null = null;
let unlisten: UnlistenFn | null = null;
let toolsReqSeq = 0;

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_AUTO_RECONNECT = 5;

function scheduleAutoReconnect() {
  if (!autoReconnectCb) return;
  if (reconnectAttempts >= MAX_AUTO_RECONNECT) {
    console.warn("[mcp] auto-reconnect: max attempts reached, giving up");
    return;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  console.log(`[mcp] auto-reconnect in ${delay}ms (attempt ${reconnectAttempts}/${MAX_AUTO_RECONNECT})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (store.mcpState === "disconnected" && autoReconnectCb) {
      autoReconnectCb();
    }
  }, delay);
}

async function refreshToolsWithRetry(opts?: {
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  reason?: string;
  initialDelayMs?: number;
}): Promise<string[]> {
  if (store.mcpState !== "connected") return store.tools;

  const attempts  = opts?.attempts    ?? 6;
  let delay       = opts?.baseDelayMs ?? 3000;
  const timeoutMs = opts?.timeoutMs   ?? 30000;

  if (opts?.initialDelayMs && opts.initialDelayMs > 0) {
    await sleep(opts.initialDelayMs);
  }

  const mySeq = ++toolsReqSeq;
  setStore({ toolsLoading: true });
  let lastErr: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (mySeq !== toolsReqSeq) return store.tools;
    if (store.mcpState !== "connected") {
      setStore({ toolsLoading: false });
      return store.tools;
    }
    try {
      const res = await withTimeout(mcpListTools(), timeoutMs, "mcp_list_tools");
      const raw = normalizeToolsResult(res);
      const names = toolNamesFrom(raw);
      if (names.length > 0) {
        if (mySeq === toolsReqSeq) {
          setStore({ tools: names, toolsRaw: raw as McpTool[], toolsLoading: false, error: null, lastToolsFetchAt: Date.now() });
        }
        return names;
      }
      lastErr = `Empty tools list (raw length: ${raw.length})`;
    } catch (e: any) {
      lastErr = e?.message || String(e);
    }
    if (attempt < attempts) {
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 10000);
    }
  }

  if (mySeq === toolsReqSeq) {
    setStore({ toolsLoading: false, error: lastErr ?? "Failed to load tools", lastToolsFetchAt: Date.now() });
  }
  return store.tools;
}

async function initialize() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const st = await mcpStatus();
      if (st.connected) {
        setStore({ mcpState: "connected", loading: false, connectedAt: Date.now() });
        void refreshToolsWithRetry({ reason: "init-connected", initialDelayMs: 500, timeoutMs: 30000 });
      } else {
        setStore({ mcpState: "disconnected", loading: false });
      }
    } catch (e: any) {
      setStore({ mcpState: "error", loading: false, error: e?.message || String(e) });
    }

    try {
      if (unlisten) { try { unlisten(); } catch { } unlisten = null; }
      unlisten = await listenMcpState((payload) => {
        const newState = payload.state;
        const patch: Partial<StoreSnapshot> = {
          mcpState: newState,
          loading: newState === "connecting",
        };
        if (newState === "error" && payload.message?.trim()) {
          patch.error = payload.message;
        } else {
          patch.error = null;
        }
        if (newState === "connected") {
          patch.connectedAt = Date.now();
          reconnectAttempts = 0;
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        }
        if (newState === "disconnected") {
          patch.tools = [];
          patch.toolsRaw = [];
          patch.toolsLoading = false;
          patch.disconnectedAt = Date.now();
        }
        setStore(patch);
        if (newState === "connected") {
          void refreshToolsWithRetry({ reason: "state-connected", initialDelayMs: 5000, baseDelayMs: 4000, timeoutMs: 30000 });
        }
        if (newState === "disconnected") {
          scheduleAutoReconnect();
        }
      });
    } catch (e) {
      setStore({ mcpState: "error", error: `Failed to set up MCP listener: ${String(e)}` });
    }
  })();
  return initPromise;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function refreshTools(): Promise<string[]> {
  if (store.mcpState !== "connected") return store.tools;
  return refreshToolsWithRetry({ reason: "manual-refresh", timeoutMs: 30000 });
}

export async function connect(cfg: McpStdioConfig): Promise<void> {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  setStore({ loading: true, error: null });
  try {
    const st = await mcpConnect(cfg);
    if (st.connected) {
      setStore({ mcpState: "connected", loading: false, connectedAt: Date.now() });
      void refreshToolsWithRetry({ reason: "connect-fallback", initialDelayMs: 5000, timeoutMs: 30000 });
    }
  } catch (e: any) {
    setStore({ loading: false, error: e?.message || String(e), mcpState: "error" });
    throw e;
  }
}

export async function disconnect(suppressAutoReconnect = false): Promise<void> {
  if (suppressAutoReconnect) {
    autoReconnectCb = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = MAX_AUTO_RECONNECT;
  }
  setStore({ loading: true });
  try {
    await mcpDisconnect();
    setStore({ loading: false, mcpState: "disconnected", tools: [], toolsRaw: [], toolsLoading: false, disconnectedAt: Date.now() });
  } catch (e: any) {
    setStore({ loading: false, error: e?.message || String(e) });
    throw e;
  }
}

export function getCachedTools(): McpTool[] {
  return store.toolsRaw;
}

export function useMcp() {
  initialize();
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    mcpState: state.mcpState,
    loading: state.loading,
    toolsLoading: state.toolsLoading,
    error: state.error,
    tools: state.tools,
    toolsRaw: state.toolsRaw,
    lastToolsFetchAt: state.lastToolsFetchAt,
    connectedAt: state.connectedAt,
    disconnectedAt: state.disconnectedAt,
    connected: state.mcpState === "connected",
    connect,
    disconnect,
    refreshTools,
  };
}