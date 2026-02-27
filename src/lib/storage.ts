import type { ChatThread, LayoutState, ProviderConfig } from "../types";

const KEYS = {
  chats: "nikolai.chats.v1",
  chatsBak: "nikolai.chats.v1.bak",
  activeChatId: "nikolai.activeChatId.v1",
  layout: "nikolai.layout.v1",

  // Provider (legacy single active config)
  provider: "nikolai.provider.v1",

  // Provider profiles (new)
  providerProfiles: "nikolai.providerProfiles.v1",
  activeProviderProfileId: "nikolai.activeProviderProfileId.v1",

  toolLog: "nikolai.toolLog.v1",
} as const;

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadChats(): ChatThread[] {
  return loadJSON<ChatThread[]>(KEYS.chats, []);
}

export function saveChats(chats: ChatThread[]) {
  // Backup last good copy
  try {
    const prev = localStorage.getItem(KEYS.chats);
    if (prev) localStorage.setItem(KEYS.chatsBak, prev);
  } catch {
    // ignore
  }

  // Try normal save
  try {
    saveJSON(KEYS.chats, chats);
    return;
  } catch {
    // Quota/corruption: trim and retry
  }

  const MAX_CHATS = 30;
  const MAX_MSGS_PER_CHAT = 120;
  const MAX_MSG_CHARS = 20000;

  const trimmed = (chats || [])
    .slice(0, MAX_CHATS)
    .map((c) => {
      const msgs = (c.messages || [])
        .slice(-MAX_MSGS_PER_CHAT)
        .map((m) => ({
          ...m,
          content:
            typeof m.content === "string" && m.content.length > MAX_MSG_CHARS
              ? m.content.slice(0, MAX_MSG_CHARS) + "\n…(trimmed)"
              : m.content,
        }));
      return { ...c, messages: msgs };
    });

  try {
    saveJSON(KEYS.chats, trimmed);
  } catch {
    // last resort: reset chats but keep backup key
    try {
      saveJSON(KEYS.chats, []);
    } catch {
      // ignore
    }
  }
}

export function loadActiveChatId(): string | null {
  return loadJSON<string | null>(KEYS.activeChatId, null);
}

export function saveActiveChatId(id: string | null) {
  saveJSON(KEYS.activeChatId, id);
}

export function loadLayout(): LayoutState {
  return loadJSON<LayoutState>(KEYS.layout, {
    leftWidth: 280,
    rightWidth: 360,
    leftCollapsed: false,
    rightCollapsed: false,
  });
}

export function saveLayout(l: LayoutState) {
  saveJSON(KEYS.layout, l);
}

// -------- Provider Profiles --------

export type ProviderProfile = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  provider: ProviderConfig; // apiKey is NOT persisted
};

function sanitizeProvider(p: ProviderConfig): ProviderConfig {
  const anyP: any = p || {};
  const kind = (anyP.kind || "ollama") as any;

  // never persist apiKey
  const { apiKey: _drop, ...rest } = anyP;

  return {
    kind,
    ollamaBaseUrl: String(rest.ollamaBaseUrl || "").trim(),
    ollamaModel: String(rest.ollamaModel || "").trim(),
    ollamaPlannerModel: rest.ollamaPlannerModel ? String(rest.ollamaPlannerModel).trim() : undefined,
  };
}

export function loadProviderProfiles(): ProviderProfile[] {
  const arr = loadJSON<ProviderProfile[]>(KEYS.providerProfiles, []);
  if (!Array.isArray(arr)) return [];

  // sanitize on load
  return arr
    .filter((x) => x && typeof x === "object" && typeof x.id === "string")
    .map((x) => ({
      ...x,
      provider: sanitizeProvider((x as any).provider || {}),
      createdAt: typeof x.createdAt === "number" ? x.createdAt : Date.now(),
      updatedAt: typeof x.updatedAt === "number" ? x.updatedAt : Date.now(),
      name: String((x as any).name || "Profile"),
    }));
}

export function saveProviderProfiles(profiles: ProviderProfile[]) {
  const safe = (profiles || []).map((p) => ({
    ...p,
    provider: sanitizeProvider(p.provider),
    name: String(p.name || "Profile"),
    createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
    updatedAt: Date.now(),
  }));
  saveJSON(KEYS.providerProfiles, safe);
}

export function loadActiveProviderProfileId(): string | null {
  return loadJSON<string | null>(KEYS.activeProviderProfileId, null);
}

export function saveActiveProviderProfileId(id: string | null) {
  saveJSON(KEYS.activeProviderProfileId, id);
}

// -------- Provider (active) --------

export function loadProvider(): ProviderConfig {
  // Prefer active profile if it exists
  const profiles = loadProviderProfiles();
  const activeId = loadActiveProviderProfileId();
  if (activeId) {
    const prof = profiles.find((p) => p.id === activeId);
    if (prof) return sanitizeProvider(prof.provider);
  }

  // Fallback to legacy stored provider
  const p = loadJSON<ProviderConfig>(KEYS.provider, {
    kind: "ollama",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    ollamaModel: "qwen2.5:7b-instruct-q4_K_M",
  });

  return sanitizeProvider(p);
}

export function saveProvider(p: ProviderConfig) {
  const sanitized = sanitizeProvider(p);

  // Always keep legacy active provider key updated
  saveJSON(KEYS.provider, sanitized);

  // If an active profile exists, update that profile too
  const activeId = loadActiveProviderProfileId();
  if (activeId) {
    const profiles = loadProviderProfiles();
    const idx = profiles.findIndex((x) => x.id === activeId);
    if (idx >= 0) {
      profiles[idx] = {
        ...profiles[idx],
        provider: sanitized,
        updatedAt: Date.now(),
      };
      saveProviderProfiles(profiles);
    }
  }
}

// ToolLog types kept for compatibility with your UI (even if you use lib/toolLog.ts elsewhere)
export type ToolLogItem = { id: string; ts: number; title: string; detail?: string };

export function loadToolLog(): ToolLogItem[] {
  return loadJSON<ToolLogItem[]>(KEYS.toolLog, []);
}

export function saveToolLog(items: ToolLogItem[]) {
  saveJSON(KEYS.toolLog, items);
}

// -------- MCP Profiles (v0.2) --------
export type McpProfile = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  command: string;
  args: string;
  cwd: string;
  autoConnect: boolean;
};

const MCP_KEYS = {
  profiles: "nikolai.mcpProfiles.v1",
  activeId: "nikolai.activeMcpProfileId.v1",
} as const;

export function loadMcpProfiles(): McpProfile[] {
  const arr = loadJSON<McpProfile[]>(MCP_KEYS.profiles, []);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p) => p && typeof p.id === "string")
    .map((p: any) => ({
      id: String(p.id),
      name: String(p.name || "MCP Profile"),
      createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
      updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : Date.now(),
      command: String(p.command || ""),
      args: String(p.args || ""),
      cwd: String(p.cwd || ""),
      autoConnect: Boolean(p.autoConnect),
    }));
}

export function saveMcpProfiles(profiles: McpProfile[]) {
  const safe = (profiles || []).map((p) => ({
    ...p,
    name: String(p.name || "MCP Profile"),
    command: String(p.command || ""),
    args: String(p.args || ""),
    cwd: String(p.cwd || ""),
    autoConnect: Boolean(p.autoConnect),
    createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
    updatedAt: Date.now(),
  }));
  saveJSON(MCP_KEYS.profiles, safe);
}

export function loadActiveMcpProfileId(): string | null {
  return loadJSON<string | null>(MCP_KEYS.activeId, null);
}

export function saveActiveMcpProfileId(id: string | null) {
  saveJSON(MCP_KEYS.activeId, id);
}