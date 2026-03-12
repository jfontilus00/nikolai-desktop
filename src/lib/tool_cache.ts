// ── Tool Catalog Cache ──────────────────────────────────────────────────────
//
// Caches tool catalog in memory to avoid repeated MCP round-trips.
// TTL: 5 minutes (tools rarely change during a session).
//
// This is a performance optimization only.
// Does NOT modify tool resolution logic or security behavior.
//

import { mcpListTools, getCachedTools as getMcpCachedTools, type McpTool } from "./mcp";

// Re-export McpTool for agentic.ts
export type { McpTool };

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolCatalog = {
  tools: McpTool[];
  aliasMap: Record<string, string>;
  timestamp: number;
  version: number;  // Incremented on each cache refresh
};

// ── Cache State ───────────────────────────────────────────────────────────────

let cachedCatalog: ToolCatalog | null = null;
let cacheTimestamp = 0;
let cacheVersion = 0;  // Incremented on each refresh

// TTL: 5 minutes (tools rarely change during a session)
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Alias Map Builder (reuses existing logic pattern) ────────────────────────
// Note: This duplicates the alias building from agentic.ts to avoid circular
// dependency. Both implementations must stay in sync.

function toKebabCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function toCamelCase(s: string): string {
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_-]+/g)
    .filter(Boolean);
  if (parts.length === 0) return s;
  return parts[0].toLowerCase() + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join("");
}

function buildAliasMap(tools: McpTool[]): Record<string, string> {
  const candidates = new Map<string, string[]>();

  function register(alias: string, full: string) {
    if (!alias) return;
    const existing = candidates.get(alias);
    if (existing) { if (!existing.includes(full)) existing.push(full); }
    else candidates.set(alias, [full]);
  }

  for (const t of tools) {
    const name = t.name;
    const base = name.split(".").pop() ?? name;
    register(name, name);
    register(base, name);
    register(toKebabCase(base), name);
    register(toCamelCase(base), name);
  }

  // Shorthand overrides
  const has = (n: string) => tools.some((t) => t.name === n);
  if (has("fs.list_directory")) register("ls", "fs.list_directory");
  if (has("fs.read_file")) register("cat", "fs.read_file");
  if (has("fs.search_files")) register("grep", "fs.search_files");

  // Only keep unambiguous aliases
  const map: Record<string, string> = {};
  for (const [alias, owners] of candidates) {
    if (owners.length === 1) map[alias] = owners[0];
  }
  return map;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Gets cached tools if TTL not expired.
 * Otherwise refreshes from MCP and caches.
 */
export async function getCachedTools(): Promise<ToolCatalog> {
  const now = Date.now();
  
  // Check if cache is still valid
  if (cachedCatalog && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedCatalog;
  }
  
  // Cache expired or empty — refresh
  try {
    const tools = await mcpListTools();
    const aliasMap = buildAliasMap(tools);

    cacheVersion++;  // Increment version on refresh
    cachedCatalog = {
      tools,
      aliasMap,
      timestamp: now,
      version: cacheVersion,
    };
    cacheTimestamp = now;

    console.log(`[tool-cache] Refreshed: ${tools.length} tools, version ${cacheVersion}, TTL ${CACHE_TTL_MS / 1000}s`);
  } catch (e: any) {
    // Fallback to MCP client's in-memory cache if available
    const mcpTools = getMcpCachedTools();
    if (mcpTools.length > 0) {
      const aliasMap = buildAliasMap(mcpTools);

      cacheVersion++;  // Increment version even on fallback
      cachedCatalog = {
        tools: mcpTools,
        aliasMap,
        timestamp: now,
        version: cacheVersion,
      };
      cacheTimestamp = now;
      console.log(`[tool-cache] Using MCP client cache: ${mcpTools.length} tools, version ${cacheVersion}`);
    } else {
      console.warn("[tool-cache] Failed to refresh tools and no fallback available");
      // Return empty catalog rather than throwing
      cacheVersion++;
      cachedCatalog = { tools: [], aliasMap: {}, timestamp: now, version: cacheVersion };
      cacheTimestamp = now;
    }
  }
  
  return cachedCatalog;
}

/**
 * Gets cached tools synchronously (may be stale).
 * Returns null if cache not initialized.
 */
export function getCachedToolsSync(): ToolCatalog | null {
  return cachedCatalog;
}

/**
 * Invalidates the tool cache.
 * Next call to getCachedTools() will refresh.
 */
export function invalidateToolCache(): void {
  cachedCatalog = null;
  cacheTimestamp = 0;
  console.log("[tool-cache] Cache invalidated");
}

/**
 * Gets cache statistics for debugging.
 */
export function getCacheStats(): {
  hasCache: boolean;
  ageSeconds: number;
  toolCount: number;
  ttlSeconds: number;
} {
  const now = Date.now();
  const age = cacheTimestamp > 0 ? (now - cacheTimestamp) / 1000 : 0;
  
  return {
    hasCache: cachedCatalog !== null,
    ageSeconds: Math.round(age),
    toolCount: cachedCatalog?.tools.length ?? 0,
    ttlSeconds: CACHE_TTL_MS / 1000,
  };
}
