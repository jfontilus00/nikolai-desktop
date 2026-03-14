import { invoke } from "@tauri-apps/api/tauri";
import { ollamaChat, type OllamaMsg } from "./ollamaChat";
import { ollamaStreamChat, StreamTimeoutError } from "./ollamaStream";
import { getCachedTools as getToolCatalog, getCachedTools, type McpTool } from "./tool_cache";
import { appendToolLog } from "./toolLog";
import { formatToolResult } from "./toolResult";
import { loadMemory, formatMemoryForPrompt, addFact } from "./memory";
import { loadIndex, searchIndex, formatSearchResults, type SemanticIndex } from "./semanticIndex";
import { startAgentMetrics, incrementStep, recordToolUsage, finishAgentMetrics, recordLowConfidenceTool, recordReasoningLength, recordToolBudgetRemaining } from "./agent_metrics";
import { createLoopGuard, recordTool, detectLoop, type LoopGuardState } from "./agent_loop_guard";
import { reflectOnToolResult } from "./toolReflection";

// ── Tool Filtering for Planner ────────────────────────────────────────────────
/**
 * Filters the full tool catalog to only tools relevant to the
 * current prompt. Reduces token usage and prevents the planner
 * from reaching for tools it doesn't need.
 *
 * Always falls back to full catalog if no category matches —
 * this prevents over-filtering on edge cases.
 */
function filterToolsForPrompt(tools: McpTool[], prompt: string): McpTool[] {
  const t = prompt.toLowerCase();

  // Detect namespace from first tool in catalog (e.g., "dev" from "dev.write_file")
  const firstTool = tools[0]?.name;
  const namespace = firstTool?.includes(".") ? firstTool.split(".")[0] : "fs";

  // Classify the request into categories
  const wantsRead   = /\b(read|open|load|show|display|view|list|what.?s in|what is in)\b/.test(t);
  const wantsWrite  = /\b(write|create|add|append|make|generate|build|scaffold|new file)\b/.test(t);
  const wantsModify = /\b(edit|modify|update|change|refactor|fix|rename|move|delete|remove)\b/.test(t);
  const wantsSearch = /\b(search|find|grep|look for|where is|which files|scan|contains)\b/.test(t);
  const wantsWeb    = /\b(search the web|look up online|fetch|browse|website|url|http)\b/.test(t);

  const allowed = new Set<string>();

  // Read and list operations
  if (wantsRead || wantsSearch) {
    allowed.add(`${namespace}.read_file`);
    allowed.add(`${namespace}.list_directory`);
    allowed.add(`${namespace}.search_files`);
    allowed.add(`${namespace}.grep_files`);
    allowed.add(`${namespace}.get_file_info`);
  }

  // Write operations — also need read to check before writing
  if (wantsWrite) {
    allowed.add(`${namespace}.write_file`);
    allowed.add(`${namespace}.create_directory`);
    allowed.add(`${namespace}.append_file`);
    allowed.add(`${namespace}.read_file`);      // check before writing
    allowed.add(`${namespace}.list_directory`); // find target location
  }

  // Modify operations — read first, then targeted destructive tools
  if (wantsModify) {
    allowed.add(`${namespace}.edit_file`);
    allowed.add(`${namespace}.read_file`);
    allowed.add(`${namespace}.list_directory`);
    // Destructive tools ONLY if explicitly named in the request
    if (/\b(delete|remove|destroy)\b/.test(t)) allowed.add(`${namespace}.delete_file`);
    if (/\b(move)\b/.test(t))                   allowed.add(`${namespace}.move_file`);
    if (/\b(rename)\b/.test(t))                 allowed.add(`${namespace}.rename_file`);
    if (/\b(copy|duplicate)\b/.test(t))         allowed.add(`${namespace}.copy_file`);
  }

  // Web tools
  if (wantsWeb) {
    allowed.add("web.search");
    allowed.add("web.fetch");
  }

  // Always include workspace/batch tools when any file op is happening
  if (wantsRead || wantsWrite || wantsModify || wantsSearch) {
    tools.forEach(tool => {
      if (tool.name.startsWith("ws_") || tool.name === "batch_commit") {
        allowed.add(tool.name);
      }
    });
  }

  // Safety fallback — if nothing matched, return full catalog
  // This prevents over-filtering on unusual or ambiguous requests
  if (allowed.size === 0) {
    console.log("[TOOLS] no category matched — using full catalog");
    return tools;
  }

  // Convert allowed tool names into suffixes
  // Example: "fs.write_file" -> ".write_file"
  const allowedSuffixes = [...allowed].map(name => {
    const idx = name.indexOf(".");
    return idx !== -1 ? name.slice(idx) : name;
  });

  // Match tools by suffix instead of exact name
  let filtered = tools.filter(tool =>
    allowedSuffixes.some(suffix => tool.name.endsWith(suffix))
  );

  // SAFETY FALLBACK — never return zero tools
  if (filtered.length === 0) {
    console.warn(
      `[TOOLS] filter returned 0 tools — falling back to full catalog`
    );
    filtered = tools;
  }

  console.log(
    `[TOOLS] filtered ${tools.length} → ${filtered.length} tools for: "${prompt.slice(0,50)}"`
  );

  return filtered;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Plan =
  | { action: "tool"; name: string; args: any; confidence?: number; reasoning?: string }
  | { action: "final"; content: string };

type StepRecord = {
  tool: string;
  args: any;
  ok: boolean;
  summary: string;
};

// ── Agent Execution Trace ────────────────────────────────────────────────────
// Records detailed decision history for debugging agent behavior.
// Trace is console-only, NOT persisted between runs.
interface ExecutionTrace {
  step: number;
  reasoning: string;
  tool?: string;
  args?: any;
  resultSummary?: string;
}

const executionTrace: ExecutionTrace[] = [];

// ── Tool confidence threshold ────────────────────────────────────────────────
// Minimum confidence required to execute a tool call.
// If confidence is below this, agent reconsiders reasoning.
const TOOL_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_CONFIDENCE = 0.7;  // Assumed confidence when not specified

// ── Reasoning requirements ───────────────────────────────────────────────────
// Minimum length for reasoning text to ensure agent explains its decision.
const MIN_REASONING_LENGTH = 10;  // characters

// ── Adaptive Tool Budget ─────────────────────────────────────────────────────
// Limits tool calls to prevent excessive usage and improve reasoning stability.
const BASE_TOOL_BUDGET = 6;       // Default tool calls allowed
const MAX_TOOL_BUDGET = 12;       // Absolute maximum for complex tasks

// ── Tool Result Cache ────────────────────────────────────────────────────────
// Caches tool results within a single agent run to prevent redundant calls.
// Cache is NOT persisted between runs — only lives for duration of agent run.
const toolResultCache = new Map<string, any>();

function getToolCacheKey(name: string, args: any): string {
  try {
    return `${name}:${JSON.stringify(args)}`;
  } catch {
    // Fallback for non-serializable args
    return `${name}:${String(args)}`;
  }
}

// Clear cache after any write/destructive operation
// so subsequent reads see fresh filesystem state
function invalidateToolCacheOnWrite(toolName: string): void {
  const writingTools = [
    "fs.write_file",
    "fs.edit_file",
    "fs.delete_file",
    "fs.move_file",
    "fs.rename_file",
    "fs.copy_file",
    "fs.create_directory",
    "batch_commit",
    "ws_write_text",
    "ws_delete",
  ];

  const isWrite = writingTools.some(
    (w) => toolName === w || toolName.endsWith(`.${w.split(".")[1]}`)
  );

  if (isWrite) {
    toolResultCache.clear();
    console.log(`[CACHE] cleared after write tool: ${toolName}`);
  }
}

// ── Batch write types (match src-tauri/src/workspace.rs exactly) ──────────────

type PendingWrite = {
  path: string;
  content: string;
};

type BatchApplyResult = {
  batch_id: string;
  applied: number;
};

type BatchRollbackResult = {
  batch_id: string;
  restored: number;
  deleted: number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

/** Hard cap on individual tool result size injected into context. */
const MAX_RESULT_CHARS = 6000;

/** How many times to retry plan parsing before giving up on a step. */
const MAX_PLAN_PARSE_RETRIES = 2;

// ── Agent Step Timeout ──────────────────────────────────────────────────────
// Maximum time allowed for each agent step to prevent hanging.
const MAX_AGENT_STEP_TIME = 60000; // 60 seconds

// ── Priority 2: Context window constants ──────────────────────────────────────
//
// After N tool steps the conversation accumulates thousands of characters.
// With an 8B model this silently truncates the beginning of context — the
// model "forgets" the original goal and starts going off-track.
//
// We keep: all original user messages (the goal) + last KEEP_LAST_TOOL_RESULTS
// tool exchange messages. Everything older is dropped.
//
export const MAX_CONTEXT_CHARS     = 10_000; // ~2500 tokens — safe headroom for most 8B models
export const KEEP_LAST_TOOL_RESULTS = 4;     // keep last 4 tool result messages

// ── Tool allowlist (SECURITY: explicit opt-in for safe tools) ────────────────
// Only tools explicitly listed here are permitted for agent execution.
// This is more secure than blocklisting because new MCP tools cannot bypass
// the filter accidentally — they must be explicitly added to the allowlist.
//
// Categories:
// - fs.*: Filesystem operations (read, write, search, list, etc.)
// - semantic.find: Semantic code search (synthetic tool)
// - memory.*: Workspace memory operations (synthetic tool)
// - hub.*: MCP hub management (refresh, status)
//
export const ALLOWED_TOOLS: string[] = [
  // Filesystem operations
  "fs.read_file",
  "fs.write_file",
  "fs.list_directory",
  "fs.search_files",
  "fs.edit_file",
  "fs.create_directory",
  "fs.delete_file",
  "fs.copy_file",
  "fs.move_file",
  "fs.rename_file",
  // Semantic search (synthetic)
  "semantic.find",
  // Memory operations (synthetic)
  "memory.add_fact",
  // Hub management
  "hub.refresh",
  "hub.status",
];

/**
 * Checks if a tool is permitted for agent execution.
 * Uses dynamic namespace detection: if MCP tools use a consistent
 * namespace (e.g., "dev.*", "fs.*", "workspace.*"), all tools in
 * that namespace are allowed. Synthetic tools (semantic.find, memory.*)
 * are always allowed if explicitly listed in ALLOWED_TOOLS.
 */
function isAgentTool(name: string, tools?: McpTool[]): boolean {
  // Always allow explicitly listed synthetic tools
  if (ALLOWED_TOOLS.some((allowed) => allowed === name)) {
    return true;
  }

  // Dynamic namespace detection for MCP tools
  if (tools && tools.length > 0) {
    // Extract namespace from first MCP tool (e.g., "dev" from "dev.write_file")
    const firstToolName = tools[0].name;
    const dotIndex = firstToolName.indexOf(".");
    
    if (dotIndex > 0) {
      const namespace = firstToolName.slice(0, dotIndex);
      // Allow all tools with the same namespace
      if (name.startsWith(namespace + ".")) {
        return true;
      }
    }
  }

  // Not in ALLOWED_TOOLS and doesn't match MCP namespace
  return false;
}

// ── Tool name aliasing ────────────────────────────────────────────────────────
//
// Models frequently emit bare names ("list_directory") instead of qualified
// names ("fs.list_directory"). This resolver maps known bare names to their
// qualified equivalents, and also does suffix-match for unique tool names.
//
// Priority: explicit map > unique suffix match > unchanged
//
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

function buildToolAliasMap(tools: McpTool[]): Record<string, string> {
  // Build alias candidates, then prune any that are ambiguous (2+ tools claim them).
  // Ambiguous aliases fall through to the suffix-match in resolveToolName.
  const candidates = new Map<string, string[]>(); // alias -> [tool names that want it]

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

  // Shorthand overrides — only add if unambiguous
  const has = (n: string) => tools.some((t) => t.name === n);
  if (has("fs.list_directory")) register("ls",   "fs.list_directory");
  if (has("fs.read_file"))      register("cat",  "fs.read_file");
  if (has("fs.search_files"))   register("grep", "fs.search_files");

  // Only keep aliases that resolve to exactly one tool
  const map: Record<string, string> = {};
  for (const [alias, owners] of candidates) {
    if (owners.length === 1) map[alias] = owners[0];
    // else: ambiguous — leave it out, suffix-match in resolveToolName handles it
  }
  return map;
}

function resolveToolName(name: string, tools: McpTool[], aliasMap: Record<string, string>): string {
  // 1. Exact match — already correct
  if (tools.some((t) => t.name === name)) return name;

  // 2. Explicit alias map
  if (aliasMap[name]) {
    const aliased = aliasMap[name];
    if (tools.some((t) => t.name === aliased)) return aliased;
  }

  // 3. Unique suffix match: if exactly one tool ends with ".{bare}", use it
  const bare = name.split(".").pop() ?? name;
  const matches = tools.filter((t) => t.name.endsWith(`.${bare}`) || t.name === bare);
  if (matches.length === 1) return matches[0].name;

  // 4. Return unchanged — will be caught as "tool not found" below
  return name;
}

function normalizeToolArgs(toolName: string, rawArgs: any): { args: any; error?: string } {
  let args = rawArgs;

  if (args == null) args = {};

  if (typeof args === "string") {
    const t = args.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        args = JSON.parse(t);
      } catch (e: any) {
        return { args: {}, error: `Tool args JSON parse failed: ${e?.message || String(e)}` };
      }
    } else {
      return { args: {}, error: "Tool args must be an object." };
    }
  }

  if (typeof args !== "object") {
    return { args: {}, error: "Tool args must be an object." };
  }

  const a = { ...(args as any) };

  if (toolName.startsWith("fs.")) {
    if (a.path == null) {
      if (a.file != null) a.path = a.file;
      if (a.filepath != null) a.path = a.filepath;
      if (a.dir != null) a.path = a.dir;
      if (a.directory != null) a.path = a.directory;
      if (a.folder != null) a.path = a.folder;
    }

    if (toolName === "fs.search_files") {
      if (a.query == null) {
        if (a.pattern != null) a.query = a.pattern;
        if (a.search != null) a.query = a.search;
      }
    }

    if (toolName === "fs.write_file") {
      if (a.content == null) {
        if (typeof a.text === "string") a.content = a.text;
        if (typeof a.data === "string") a.content = a.data;
      }
    }

    if (toolName === "fs.copy_file" || toolName === "fs.move_file" || toolName === "fs.rename_file") {
      if (Array.isArray(a.paths)) {
        if (a.src == null) a.src = a.paths[0];
        if (a.dst == null) a.dst = a.paths[1];
        if (a.from == null) a.from = a.paths[0];
        if (a.to == null) a.to = a.paths[1];
        if (a.source == null) a.source = a.paths[0];
        if (a.destination == null) a.destination = a.paths[1];
      }
    }

    const missing: string[] = [];
    if (["fs.read_file", "fs.list_directory", "fs.create_directory", "fs.delete_file", "fs.edit_file"].includes(toolName)) {
      if (!a.path) missing.push("path");
    }
    if (toolName === "fs.search_files") {
      if (!a.path) missing.push("path");
      if (!a.query) missing.push("query");
    }
    if (toolName === "fs.write_file") {
      if (!a.path) missing.push("path");
      if (typeof a.content !== "string") missing.push("content");
    }
    if (toolName === "fs.copy_file" || toolName === "fs.move_file" || toolName === "fs.rename_file") {
      const src = a.src ?? a.from ?? a.source;
      const dst = a.dst ?? a.to ?? a.destination;
      if (!src) missing.push("src");
      if (!dst) missing.push("dst");
    }
    if (missing.length) {
      return { args: a, error: `Missing required args: ${missing.join(", ")}` };
    }
  }

  return { args: a };
}



function isTauri(): boolean {
  return typeof window !== "undefined" &&
    ((window as any).__TAURI__ != null || (window as any).__TAURI_IPC__ != null);
}

// ── Workspace root check ──────────────────────────────────────────────────────

async function getWorkspaceRoot(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const raw = await invoke<string | null>("ws_get_root");
    if (!raw) return null;
    // Strip Windows \\?\\ extended-length prefix added by Rust canonicalize().
    // Without this, path comparisons and batch path stripping fail.
    let stripped = raw;
    if (stripped.startsWith("\\\\?\\")) stripped = stripped.slice(4);
    if (stripped.startsWith("//?/")) stripped = stripped.slice(4);
    return stripped.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

// ── V4-B: Silent tool runner (no log, no status, no step record) ──────────────
// Used for context grounding calls that happen before the main loop.
// We don't want these to show up in tool logs or action cards.
async function silentTool(
  exec: (name: string, args: any) => Promise<any>,
  name: string,
  args: any,
): Promise<string> {
  try {
    const out = await exec(name, args);
    return formatToolResult(name, out).text;
  } catch {
    return "";
  }
}

// ── Atomic batch commit ───────────────────────────────────────────────────────

async function commitBatch(
  pendingWrites: PendingWrite[],
  onStatus?: (s: string) => void,
): Promise<{ ok: true; result: BatchApplyResult } | { ok: false; error: string }> {
  if (!isTauri()) return { ok: false, error: "Tauri not available" };

  onStatus?.(`💾 Committing ${pendingWrites.length} file(s) atomically…`);

  try {
    const result = await invoke<BatchApplyResult>("ws_batch_apply", {
      files: pendingWrites.map((w) => ({ path: w.path, content: w.content })),
    });
    appendToolLog({
      id: `tl-batch-${Date.now()}`,
      ts: Date.now(),
      tool: "ws_batch_apply",
      args: { count: pendingWrites.length, files: pendingWrites.map((w) => w.path) },
      ok: true,
      result: { batch_id: result.batch_id, applied: result.applied },
    });
    return { ok: true, result };
  } catch (e: any) {
    const errText = e?.message || String(e);
    appendToolLog({
      id: `tl-batch-err-${Date.now()}`,
      ts: Date.now(),
      tool: "ws_batch_apply",
      args: { count: pendingWrites.length },
      ok: false,
      error: errText,
    });
    return { ok: false, error: errText };
  } finally {
    onStatus?.("");
  }
}

async function rollbackBatch(
  batchId: string | null,
  onStatus?: (s: string) => void,
): Promise<{ restored: number; deleted: number } | null> {
  if (!isTauri()) return null;
  onStatus?.("⏪ Rolling back changes…");
  try {
    const result = await invoke<BatchRollbackResult>("ws_batch_rollback", {
      batch_id: batchId ?? null,
    });
    appendToolLog({
      id: `tl-rollback-${Date.now()}`,
      ts: Date.now(),
      tool: "ws_batch_rollback",
      args: { batch_id: batchId },
      ok: true,
      result,
    });
    return { restored: result.restored, deleted: result.deleted };
  } catch (e: any) {
    appendToolLog({
      id: `tl-rollback-err-${Date.now()}`,
      ts: Date.now(),
      tool: "ws_batch_rollback",
      args: { batch_id: batchId },
      ok: false,
      error: e?.message || String(e),
    });
    return null;
  } finally {
    onStatus?.("");
  }
}

// ── Priority 2: Context window sliding ───────────────────────────────────────
//
// PROBLEM: convo grows unbounded as tool results are appended. After 8+ steps,
// context can exceed 20,000 chars. An 8B model silently truncates the start,
// losing the original user request — the agent goes off-track.
//
// SOLUTION: before each planner call, trim convo:
//   - Keep ALL original user/system messages (the task description)
//   - Keep only the LAST N tool-exchange messages (recent results)
//   - Hard cap total chars, truncating individual results if still too large
//
// Tool-exchange messages are identified by their content prefix:
// "[tool result:", "[tool error:", "[tool blocked]", "[tool not found]", "[planner"
//
function isToolExchangeMessage(msg: OllamaMsg): boolean {
  const c = String(msg.content || "");
  return (
    c.startsWith("[tool result:") ||
    c.startsWith("[tool error:") ||
    c.startsWith("[tool blocked]") ||
    c.startsWith("[tool not found]") ||
    c.startsWith("[planner") ||
    // parse-retry correction messages
    (msg.role === "user" && c.startsWith("Your previous response was not valid JSON"))
  );
}

export function trimContext(convo: OllamaMsg[]): OllamaMsg[] {
  // Find where tool exchange starts
  const firstToolIdx = convo.findIndex(isToolExchangeMessage);
  if (firstToolIdx < 0) return convo; // no tool messages yet — nothing to trim

  const originalMsgs  = convo.slice(0, firstToolIdx);
  const toolExchange  = convo.slice(firstToolIdx);

  // Keep only the last KEEP_LAST_TOOL_RESULTS tool exchange messages
  const dropped = toolExchange.length > KEEP_LAST_TOOL_RESULTS
    ? toolExchange.slice(0, -KEEP_LAST_TOOL_RESULTS)
    : [];
  const kept = toolExchange.length > KEEP_LAST_TOOL_RESULTS
    ? toolExchange.slice(-KEEP_LAST_TOOL_RESULTS)
    : toolExchange;

  // ── Context Summarization ──────────────────────────────────────────────────
  // When we drop old tool messages, create a summary so the agent remembers
  // what was done. This prevents losing important context on long runs.
  let summaryMsg: OllamaMsg | null = null;
  if (dropped.length > 0) {
    const summary = summarizeDroppedTools(dropped);
    summaryMsg = { role: "system" as const, content: summary };
  }

  const trimmed = [...originalMsgs, ...(summaryMsg ? [summaryMsg] : []), ...kept];

  // Check total char count
  const totalChars = trimmed.reduce((s, m) => s + (m.content || "").length, 0);
  if (totalChars <= MAX_CONTEXT_CHARS) return trimmed;

  // Still too large — truncate individual large tool results
  return trimmed.map((m) => {
    const c = String(m.content || "");
    if (
      (c.startsWith("[tool result:") || c.startsWith("[tool error:")) &&
      c.length > 1500
    ) {
      return { ...m, content: c.slice(0, 1500) + "\n…[trimmed to save context window]" };
    }
    return m;
  });
}

// ── Summarize Dropped Tool Messages ──────────────────────────────────────────
// Creates a compact summary of tool executions that were dropped from context.
// This preserves important information while reducing token count.

function summarizeDroppedTools(dropped: OllamaMsg[]): string {
  const toolCalls: string[] = [];
  const errors: string[] = [];
  const modifiedFiles: string[] = [];

  for (const msg of dropped) {
    const content = String(msg.content || "");

    // Extract tool name from [tool result: toolName] or [tool error: toolName]
    const match = content.match(/^\[(?:tool result|tool error):\s*([^\]]+)\]/);
    if (!match) continue;

    const toolName = match[1].trim();
    const isError = content.startsWith("[tool error:");

    // Track tool calls
    if (!toolCalls.includes(toolName)) {
      toolCalls.push(toolName);
    }

    // Track errors
    if (isError) {
      const errorDetail = content.split("\n")[1]?.slice(0, 100) || "Unknown error";
      errors.push(`${toolName}: ${errorDetail}`);
    }

    // Track file modifications
    if (toolName.startsWith("fs.") && !isError) {
      const pathMatch = content.match(/path["':\s]+([^\s,\n\)]+)/i) ||
                        content.match(/Staged:\s*([^\s(]+)/i);
      if (pathMatch && pathMatch[1]) {
        const path = pathMatch[1].replace(/["',]/g, "");
        if (!modifiedFiles.includes(path)) {
          modifiedFiles.push(path);
        }
      }
    }
  }

  // Build summary
  const lines: string[] = [
    `[summary of earlier steps]`,
    `Tools executed (${toolCalls.length} total):`,
  ];

  if (toolCalls.length > 0) {
    // Group by prefix (e.g., "fs.*" → "filesystem operations")
    const fsTools = toolCalls.filter(t => t.startsWith("fs."));
    const hubTools = toolCalls.filter(t => t.startsWith("hub."));
    const otherTools = toolCalls.filter(t => !t.startsWith("fs.") && !t.startsWith("hub."));

    if (fsTools.length > 0) lines.push(`  • Filesystem: ${fsTools.map(t => t.split(".").pop()).join(", ")}`);
    if (hubTools.length > 0) lines.push(`  • Hub: ${hubTools.map(t => t.split(".").pop()).join(", ")}`);
    if (otherTools.length > 0) lines.push(`  • Other: ${otherTools.join(", ")}`);
  } else {
    lines.push(`  (none)`);
  }

  if (errors.length > 0) {
    lines.push(`\nErrors (${errors.length}):`);
    errors.slice(0, 5).forEach(e => lines.push(`  • ${e}`));
    if (errors.length > 5) lines.push(`  • ...and ${errors.length - 5} more`);
  } else {
    lines.push(`\nErrors: none`);
  }

  if (modifiedFiles.length > 0) {
    lines.push(`\nFiles modified (${modifiedFiles.length}):`);
    modifiedFiles.slice(0, 5).forEach(f => lines.push(`  • ${f}`));
    if (modifiedFiles.length > 5) lines.push(`  • ...and ${modifiedFiles.length - 5} more`);
  }

  lines.push(`\n[end summary — continue with recent tool results below]`);

  return lines.join("\n");
}

// ── Human-readable status messages ───────────────────────────────────────────

function humanStatus(toolName: string, args: any): string {
  const a = args && typeof args === "object" ? args : {};
  const short = (s: string, max = 50) =>
    typeof s === "string" && s.length > max ? s.slice(0, max) + "…" : s;

  if (toolName === "fs.read_file")        return `📖 Reading ${short(a.path ?? "file")}`;
  if (toolName === "fs.write_file")       return `📋 Staging ${short(a.path ?? "file")}`;
  if (toolName === "fs.edit_file")        return `✏️  Editing ${short(a.path ?? "file")}`;
  if (toolName === "fs.list_directory")   return `📁 Listing ${short(a.path ?? "directory")}`;
  if (toolName === "fs.search_files")     return `🔍 Searching "${short(a.query ?? "…")}" in ${short(a.path ?? ".")}`;
  if (toolName === "semantic.find")       return `🧠 Semantic search: "${short(a.query ?? "…")}"`;
  if (toolName === "fs.create_directory") return `📁 Creating directory ${short(a.path ?? "")}`;
  if (toolName === "fs.delete_file")      return `🗑  Deleting ${short(a.path ?? "file")}`;
  if (toolName === "fs.move_file")        return `📦 Moving ${short(a.src ?? a.from ?? "file")}`;
  if (toolName === "fs.copy_file")        return `📋 Copying ${short(a.src ?? a.from ?? "file")}`;
  if (toolName === "hub.status")          return `⚙️  Checking hub status`;
  if (toolName === "hub.refresh")         return `🔄 Refreshing hub`;
  if (toolName.includes("export_docx"))   return `📄 Exporting Word document`;
  if (toolName.includes("export_pdf"))    return `📄 Exporting PDF`;
  if (toolName.includes("export_pptx"))   return `📊 Exporting PowerPoint`;
  if (toolName.includes("export_xlsx"))   return `📊 Exporting spreadsheet`;
  if (toolName.includes("export_"))       return `📄 Exporting document`;
  if (toolName.includes("render_"))       return `🖼  Rendering document`;
  if (toolName.includes("project-brain")) return `🧠 Querying project brain`;

  const bare = toolName.split(".").pop() ?? toolName;
  return `⚙️  Running ${bare}`;
}

function humanSummary(toolName: string, args: any, ok: boolean, resultText: string): string {
  const a = args && typeof args === "object" ? args : {};
  const short = (s: string, max = 40) =>
    typeof s === "string" && s.length > max ? s.slice(0, max) + "…" : s;
  const icon = ok ? "✓" : "✗";

  if (toolName === "fs.read_file")
    return `${icon} Read ${short(a.path ?? "file")}${ok ? ` (${resultText.length} chars)` : `: ${resultText}`}`;
  if (toolName === "fs.write_file") {
    if (!ok) return `✗ FAILED to stage ${short(a.path ?? "file")}: ${String(resultText || "").slice(0, 140)}`;
    return `${icon} Staged ${short(a.path ?? "file")} for batch write`;
  }
  if (toolName === "fs.edit_file")
    return `${icon} Edited ${short(a.path ?? "file")}`;
  if (toolName === "fs.list_directory")
    return `${icon} Listed ${short(a.path ?? "directory")}`;
  if (toolName === "fs.search_files")
    return `${icon} Searched "${short(a.query ?? "")}"`;
  if (toolName === "semantic.find")
    return `${icon} Semantic: "${short(a.query ?? "")}"${ok ? "" : ` — ${resultText.slice(0, 50)}`}`;
  if (toolName === "memory.add_fact")
    return `${icon} ${ok ? "Saved to memory:" : "Memory save failed:"} "${short(a.text ?? "")}"`;
  if (!ok) return `${icon} ${toolName.split(".").pop()} failed: ${resultText.slice(0, 60)}`;
  return `${icon} ${toolName.split(".").pop()}`;
}

// ── Tool result truncation ────────────────────────────────────────────────────

function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const head = text.slice(0, MAX_RESULT_CHARS);
  const remaining = text.length - MAX_RESULT_CHARS;
  return (
    head +
    `\n\n[⚠ Result truncated: ${remaining.toLocaleString()} more chars omitted. ` +
    `Use fs.search_files to find keywords, or request a smaller file range.]`
  );
}

// ── Plan parsing ──────────────────────────────────────────────────────────────

function stripCodeFences(s: string) {
  return (s || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

// ── Safe JSON Repair for LLM Responses ──────────────────────────────────────
// LLMs often produce malformed JSON. This function attempts lightweight repairs
// before giving up. Handles common issues:
// - Unquoted keys: { tool: "..." } → { "tool": "..." }
// - Trailing commas: { "a": 1, } → { "a": 1 }
// - Single quotes: { 'a': 1 } → { "a": 1 }
// - Markdown artifacts: Extra whitespace, code fence remnants

function repairJsonString(jsonStr: string): string {
  let repaired = jsonStr;

  // Step 1: Remove trailing commas before } or ]
  // Matches: , followed by optional whitespace and } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // Step 2: Quote unquoted keys
  // Matches: word characters at start of key position (after { or ,)
  // Pattern: { or , followed by whitespace, then unquoted key, then :
  repaired = repaired.replace(
    /([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g,
    '$1"$2":'
  );

  // Step 3: Convert single quotes to double quotes for keys and string values
  // This is tricky - we need to be careful not to break strings containing '
  // Simple approach: convert '{' to "{" when it looks like a key or value marker
  repaired = repaired.replace(
    /'([^']*)'\s*:/g,
    '"$1":'
  );

  // Step 4: Normalize escaped newlines that might break parsing
  repaired = repaired.replace(/\\n/g, '\n');

  // Step 5: Remove any remaining markdown artifacts
  repaired = repaired.replace(/```\s*/g, '').replace(/\*\*/g, '');

  return repaired;
}

export function parsePlan(raw: string): Plan | null {
  const cleaned = stripCodeFences(raw);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  const jsonCandidate = cleaned.slice(start, end + 1);

  // Attempt 1: Try normal JSON parse (fast path for well-formed JSON)
  try {
    const obj: any = JSON.parse(jsonCandidate);
    if (obj?.action === "tool" && typeof obj?.name === "string") {
      return { action: "tool", name: obj.name, args: obj.args ?? {} };
    }
    if (obj?.action === "final" && typeof obj?.content === "string") {
      return { action: "final", content: obj.content };
    }
    return null;
  } catch {
    // Parse failed — try repair
  }

  // Attempt 2: Try repaired JSON
  try {
    const repaired = repairJsonString(jsonCandidate);
    const obj: any = JSON.parse(repaired);
    if (obj?.action === "tool" && typeof obj?.name === "string") {
      return { action: "tool", name: obj.name, args: obj.args ?? {} };
    }
    if (obj?.action === "final" && typeof obj?.content === "string") {
      return { action: "final", content: obj.content };
    }
    return null;
  } catch {
    // Repair also failed — return null (existing error behavior)
    return null;
  }
}

// ── Plan Verification ────────────────────────────────────────────────────────
// Validates that a parsed plan is structurally valid before execution.
// This catches malformed or incomplete plans before wasting tool budget.

async function verifyPlan(plan: Plan, _userGoal: string): Promise<{ valid: boolean; reason: string }> {
  // Serialize plan for inspection
  const planText = JSON.stringify(plan);

  // Check for empty or near-empty plan
  if (!planText || planText.length < 5) {
    return { valid: false, reason: "empty plan" };
  }

  // Check for required fields based on action type
  if (plan.action === "tool") {
    if (!plan.name || typeof plan.name !== "string") {
      return { valid: false, reason: "missing tool name" };
    }
    if (plan.args === undefined || plan.args === null) {
      return { valid: false, reason: "missing tool args" };
    }
  } else if (plan.action === "final") {
    if (!plan.content || typeof plan.content !== "string") {
      return { valid: false, reason: "missing final content" };
    }
  } else {
    return { valid: false, reason: "unknown action type" };
  }

  // Plan passed basic validation
  return { valid: true, reason: "" };
}

// ── Tool catalog ──────────────────────────────────────────────────────────────
//
// MCP tools from cache + optional synthetic tools.
// semantic.find is prepended when an index exists — the planner will
// prefer it over repeated list_directory/read_file chains.

const SEMANTIC_TOOL_DESCRIPTION =
  `semantic.find — Search the codebase by MEANING. ` +
  `Use when you need to locate code by concept/purpose (e.g. "error handling", "auth middleware", "database query"). ` +
  `Returns top matching files with relevant code snippets in ONE step. ` +
  `Much faster than list_directory → read_file chains. ` +
  `Args: {"query": "<natural language>", "top_k": 5}`;

// Only shown when workspace root is set — facts are workspace-scoped
const MEMORY_TOOL_DESCRIPTION =
  `memory.add_fact — Save a permanent fact about this workspace. ` +
  `Use ONLY when the user explicitly says "remember", "note that", "save that", or similar. ` +
  `Do NOT use speculatively or for general observations. ` +
  `Args: {"text": "<single clear fact to remember, one sentence>"}`;

function toolCatalog(tools: McpTool[], hasSemanticIndex: boolean, hasWorkspaceRoot: boolean): string {
  const lines: string[] = [];

  if (hasSemanticIndex) {
    lines.push(`- ${SEMANTIC_TOOL_DESCRIPTION}`);
  }
  if (hasWorkspaceRoot) {
    lines.push(`- ${MEMORY_TOOL_DESCRIPTION}`);
  }

  const allowed = (tools || []).filter((t) => isAgentTool(t.name, tools));
  for (const t of allowed) {
    lines.push(`- ${t.name}${t.description ? ` — ${t.description}` : ""}`);
  }

  return lines.length > 0 ? lines.join("\n") : "(no tools available)";
}

// ── Core single-tool runner ───────────────────────────────────────────────────

async function runTool(opts: {
  toolName: string;
  args: any;
  exec: (name: string, args: any, signal?: AbortSignal) => Promise<any>;
  onStatus?: (s: string) => void;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; text: string }> {
  opts.onStatus?.(humanStatus(opts.toolName, opts.args));

  try {
    const out = await opts.exec(opts.toolName, opts.args ?? {}, opts.signal);
    const formatted = formatToolResult(opts.toolName, out);

    appendToolLog({
      id: `tl-${Date.now()}`,
      ts: Date.now(),
      tool: opts.toolName,
      args: opts.args ?? {},
      ok: !formatted.isError,
      result: formatted.isError ? undefined : out,
      error: formatted.isError ? formatted.text : undefined,
    });

    const text = truncateResult(formatted.text);
    return { ok: !formatted.isError, text };
  } catch (e: any) {
    const errText = e?.message || String(e);
    appendToolLog({
      id: `tl-err-${Date.now()}`,
      ts: Date.now(),
      tool: opts.toolName,
      args: opts.args ?? {},
      ok: false,
      error: errText,
    });
    return { ok: false, text: errText };
  } finally {
    opts.onStatus?.("");
  }
}

// ── Planner system prompt ─────────────────────────────────────────────────────

function buildPlannerSystem(
  catalog: string,
  step: number,
  maxSteps: number,
  batchMode: boolean,
  memoryText?: string,
): OllamaMsg {
  const batchNote = batchMode
    ? `\nBATCH MODE ACTIVE: fs.write_file calls are staged in memory and committed atomically at the end. ` +
      `Do NOT try to read a file you just staged — plan all writes first, then use action:final.\n` +
      `PATH RULE (CRITICAL): ALWAYS use RELATIVE paths only (e.g. 'file.txt' or 'subdir/file.txt'). ` +
      `NEVER use absolute paths like C:\\... or /Users/... — the workspace root is already set for you.\n`
    : `\nNo workspace root set — writes execute immediately via MCP.\n`;

  // ── V4-C: Inject remembered facts ─────────────────────────────────────────
  const memNote = memoryText
    ? `\nKnown facts about this workspace (from memory):\n${memoryText}\n`
    : "";

  return {
    role: "system",
    content:
      `You are a precise tool planner (step ${step}/${maxSteps}).${batchNote}${memNote}\n` +
      `Output EXACTLY ONE JSON object — no other text, no markdown, no explanation.\n\n` +
      `TWO valid output shapes:\n` +
      `1. Call a tool:   {"action":"tool","name":"<exact_tool_name>","args":{...}}\n` +
      `2. Done:          {"action":"final","content":"...your final answer..."}\n\n` +
      `Before using any tool, ask: "Does this task REQUIRE filesystem access, or can I answer directly from my knowledge?"\n\n` +
      `Answer directly (no tools) when user is:\n` +
      `- Asking a question or seeking an explanation\n` +
      `- Brainstorming, planning, or discussing ideas\n` +
      `- Reviewing their own thinking or approach\n\n` +
      `Use tools only when user is:\n` +
      `- Explicitly asking to read, write, list, or search files\n` +
      `- Referencing a specific file path or filename\n` +
      `- Asking to modify or create code in the codebase\n\n` +
      `Default: respond directly. Use tools only when clearly required.\n\n` +
      `Rules:\n` +
      `- Output JSON only. Any prose = invalid.\n` +
      `- Use "final" when you have enough to answer or all writes are planned.\n` +
      `- Only use filesystem tools when the task EXPLICITLY requires file access.\n` +
      `- If the user is brainstorming, asking questions, or discussing ideas, respond directly without tools.\n` +
      `- Use fs.read_file only when you need to read a specific named file.\n` +
      `- Use fs.list_directory only when the user explicitly asks to see directory contents.\n` +
      `- When uncertain whether a tool is needed, prefer responding directly without tools.\n` +
      `- Do NOT explore the filesystem proactively — only access files when clearly required.\n` +
      `- Avoid node_modules, .git, dist, build directories.\n\n` +
      `Example:  {"action":"tool","name":"fs.read_file","args":{"path":"src/App.tsx"}}\n` +
      `Example:  {"action":"final","content":"Done."}\n\n` +
      `Available tools:\n${catalog}`,
  };
}

// ── Agent Run Persistence (lightweight recovery) ─────────────────────────────
// Minimal state persisted to localStorage so agent runs can survive UI reloads
// or crashes. Only stores essential info for recovery, not full conversation.

type AgentRunState = {
  runId: string;
  step: number;
  maxSteps: number;
  workspaceRoot: string | null;
  lastTool: string | null;
  lastToolArgs: any | null;
  lastToolOk: boolean | null;
  timestamp: number;
  status: "running" | "completed" | "failed" | "interrupted";
};

const AGENT_RUN_STORAGE_KEY = "nikolai.agent.run.v1";

// ── Export for graceful shutdown hook ────────────────────────────────────────
export function saveAgentRunState(state: Partial<AgentRunState>): void {
  try {
    const existingRaw = localStorage.getItem(AGENT_RUN_STORAGE_KEY);
    const existing: Partial<AgentRunState> = existingRaw ? JSON.parse(existingRaw) : {};
    const merged = { ...existing, ...state, timestamp: Date.now() };
    localStorage.setItem(AGENT_RUN_STORAGE_KEY, JSON.stringify(merged));
  } catch (e) {
    // Private browsing, quota exceeded, storage disabled, security restrictions
    console.warn("[agentic] persistence failed: saveAgentRunState", e);
  }
}

function loadAgentRunState(): AgentRunState | null {
  try {
    const raw = localStorage.getItem(AGENT_RUN_STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as AgentRunState;
    // Invalidate if older than 1 hour (stale run)
    if (Date.now() - state.timestamp > 60 * 60 * 1000) {
      clearAgentRunState();
      return null;
    }
    return state;
  } catch (e) {
    // Private browsing, quota exceeded, storage disabled, security restrictions
    console.warn("[agentic] persistence failed: loadAgentRunState", e);
    return null;
  }
}

function clearAgentRunState(): void {
  try {
    localStorage.removeItem(AGENT_RUN_STORAGE_KEY);
  } catch (e) {
    // Private browsing, quota exceeded, storage disabled, security restrictions
    console.warn("[agentic] persistence failed: clearAgentRunState", e);
  }
}

function markAgentRunComplete(): void {
  try {
    saveAgentRunState({ status: "completed" });
  } catch (e) {
    console.warn("[agentic] persistence failed: markAgentRunComplete", e);
  }
}

// ── Adaptive Tool Budget Helper ──────────────────────────────────────────────
// Computes tool budget based on user input complexity.
// Shorter inputs need fewer tools; longer inputs may need more exploration.
function computeToolBudget(userPrompt: string): number {
  const length = userPrompt.length;
  
  if (length < 80) return 3;       // Simple question
  if (length < 200) return 5;      // Moderate task
  if (length < 500) return 8;      // Complex task
  
  return BASE_TOOL_BUDGET;         // Default for very long inputs
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function agenticStreamChat(opts: {
  baseUrl: string;
  model: string;
  messages: OllamaMsg[];
  signal: AbortSignal;
  onToken: (t: string) => void;
  onStatus?: (s: string) => void;
  maxSteps?: number;
  executeTool?: (name: string, args: any, signal?: AbortSignal) => Promise<any>;
  plannerModel?: string;
  // Optional overrides — allows non-Ollama providers (Anthropic, OpenAI, etc.)
  // to drive the agentic loop. When omitted, defaults to ollamaChat/ollamaStreamChat.
  chatFn?: (messages: OllamaMsg[], signal: AbortSignal) => Promise<string>;
  streamFn?: (messages: OllamaMsg[], signal: AbortSignal, onToken: (t: string) => void) => Promise<void>;
  // Optional: unique run ID for persistence (auto-generated if not provided)
  runId?: string;
  // Original user prompt for tool filtering
  prompt?: string;
}): Promise<void> {
  // Clear trace from previous run
  executionTrace.length = 0;

  const maxSteps = opts.maxSteps ?? 10;
  const runId = opts.runId || `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  // ── Recovery check: detect interrupted run ────────────────────────────────
  // If a previous run exists and is marked as "running", it was interrupted.
  // We notify the user but don't auto-resume (would require UI integration).
  const prevRun = loadAgentRunState();
  if (prevRun && prevRun.status === "running") {
    console.warn(
      `[agentic] Detected interrupted run from ${new Date(prevRun.timestamp).toLocaleString()}. ` +
      `Run ID: ${prevRun.runId}, Step: ${prevRun.step}/${prevRun.maxSteps}`
    );
    // Clear stale run — new run will start fresh
    clearAgentRunState();
  }

  // Initialize persistence for this run
  saveAgentRunState({
    runId,
    step: 0,
    maxSteps,
    workspaceRoot: null,
    lastTool: null,
    lastToolArgs: null,
    lastToolOk: null,
    status: "running",
  });

  // ── Start metrics tracking ─────────────────────────────────────────────────
  startAgentMetrics(runId, opts.model);

  // ── Compute adaptive tool budget ──────────────────────────────────────────
  // Budget based on user input complexity.
  const firstUserMsg = opts.messages.find((m) => m.role === "user");
  let toolBudget = computeToolBudget(firstUserMsg?.content || "");
  console.log(`[agentic] tool budget: ${toolBudget} calls (BASE=${BASE_TOOL_BUDGET}, MAX=${MAX_TOOL_BUDGET})`);

  if (!opts.executeTool) {
    opts.onToken(`\n\n[agent] No tool executor provided. Tool calls are blocked.\n`);
    clearAgentRunState();
    finishAgentMetrics();
    return;
  }

  // Use the tool catalog cache — avoids MCP round-trip on every agentic request.
  // Cache TTL is 5 minutes; refreshes automatically if expired.
  let toolCatalogCache = await getToolCatalog();
  let tools: McpTool[] = toolCatalogCache.tools;
  let aliasMap = toolCatalogCache.aliasMap;
  let catalogVersion = toolCatalogCache.version;  // Track version for sync

  if (tools.length === 0) {
    opts.onToken(
      `\n\n[agent] No tools loaded yet. Go to Settings → Tools → Connect ` +
      `and wait for the tool list to populate, then try again.\n`
    );
    saveAgentRunState({ status: "failed" });
    finishAgentMetrics();
    return;
  }

  // Determine batch mode (workspace root required)
  let workspaceRoot = await getWorkspaceRoot();
  let batchMode = workspaceRoot != null;
  
  // Persist workspace root for recovery
  saveAgentRunState({ workspaceRoot });
  
  const pendingWrites: PendingWrite[] = [];

  // ── Workspace preflight ───────────────────────────────────────────────────
  // Before the loop starts, verify the workspace root is actually accessible
  // by the MCP filesystem server (inside its allowed directories).
  //
  // This catches the #1 failure mode: root is set to C:/myproject but the MCP
  // server's allowed dirs are C:/Dev — every fs.* call silently fails.
  // We catch it here with a clear message rather than burning all 12 steps.
  if (batchMode && workspaceRoot && opts.executeTool) {
    opts.onStatus?.("🔍 Checking workspace access…");
    try {
      // Ask the FS server what directories it's allowed to access
      const allowedResult = await silentTool(opts.executeTool, "fs.list_allowed_directories", {});

      if (allowedResult && allowedResult.trim().length > 0 && !allowedResult.includes("does not exist")) {
        let rawList: string[] | null = null;
        try {
          const start = allowedResult.indexOf("{");
          const end = allowedResult.lastIndexOf("}");
          if (start >= 0 && end > start) {
            const json = JSON.parse(allowedResult.slice(start, end + 1));
            if (Array.isArray(json?.allowed)) rawList = json.allowed.map((v: any) => String(v));
          }
        } catch {}
        const allowedPaths = (rawList ?? allowedResult.split(/\r?\n/))
          .map((l) => l.replace(/^[-\s\[dir\]]+/, "").trim().replace(/\\/g, "/").toLowerCase().replace(/\/+/g, "/").replace(/\/+$/, ""))
          .filter((l) => l.length > 3 && !l.startsWith("[") && !l.startsWith("("));

        const normalizedRoot = workspaceRoot.replace(/\\/g, "/").toLowerCase().replace(/\/+/g, "/").replace(/\/+$/, "");

        const isUnderAllowed = allowedPaths.some((allowed) => {
          const normAllowed = allowed.replace(/\/+$/, "");
          return (
            normalizedRoot === normAllowed ||
            normalizedRoot.startsWith(normAllowed + "/")
          );
        });

        if (!isUnderAllowed && allowedPaths.length > 0) {
          const allowedList = allowedPaths.slice(0, 5).join("\n  • ");
          opts.onToken(
            `⚠️ **Workspace root is not accessible to the MCP filesystem server.**\n\n` +
            `**Current root:** \`${workspaceRoot}\`\n\n` +
            `**MCP allowed directories:**\n  • ${allowedList}\n\n` +
            `**Fix:** In the Workspace panel, choose a root that is inside one of the allowed directories above, ` +
            `or update your MCP server config to allow \`${workspaceRoot}\`.\n`
          );
          opts.onStatus?.("");
          return; // abort the run — no point proceeding
        }
      }
    } catch {
      // preflight is best-effort — if fs.list_allowed_directories doesn't exist, continue
    }
    opts.onStatus?.("");
  }

  // ── V4-C: Load session memory ─────────────────────────────────────────────
  const memoryFacts = workspaceRoot ? loadMemory(workspaceRoot) : [];
  const memoryText  = formatMemoryForPrompt(memoryFacts);

  // ── V5: Load semantic index ───────────────────────────────────────────────
  // Built once by the user in WorkspacePanel → "Build Semantic Index".
  // If present, adds "semantic.find" to the tool catalog so the planner can
  // search by meaning instead of wasting 3-5 steps on file discovery.
  const semanticIndex:    SemanticIndex | null = workspaceRoot ? loadIndex(workspaceRoot) : null;
  const hasSemanticIndex: boolean              = (semanticIndex?.chunks?.length ?? 0) > 0;

  // ── V4-B: Context grounding ───────────────────────────────────────────────
  // Before the loop starts, silently read the project root structure and
  // README so the agent already knows where it is. This saves step 1 on
  // almost every agentic task (previously: always list_directory first).
  // Uses silentTool — no log entry, no action card, no status flash.
  let convo: OllamaMsg[] = [...opts.messages];

  if (batchMode && opts.executeTool) {
    opts.onStatus?.("📂 Reading project context…");
    try {
      const listText = await silentTool(opts.executeTool, "fs.list_directory", { path: "." });
      if (listText) {
        let grounding = `Workspace root: ${workspaceRoot}\n\nProject structure:\n${listText.slice(0, 1500)}`;
        // Try README.md — highly useful for agent orientation
        const readmeText = await silentTool(opts.executeTool, "fs.read_file", { path: "README.md" });
        if (readmeText) grounding += `\n\nREADME.md:\n${readmeText.slice(0, 800)}`;
        // Prepend as a system message so it doesn't get trimmed by trimContext
        convo = [
          { role: "system" as const, content: grounding },
          ...convo,
        ];
      }
    } catch { /* grounding is best-effort */ }
    opts.onStatus?.("");
  }

  // Batching executor — intercepts fs.write_file, stages instead of writing
  // ── Path helpers for batch mode ───────────────────────────────────────────
  function normalizeBatchPath(p: string): string {
    let s = String(p || "").trim();
    if (s.startsWith("\\\\?\\")) s = s.slice(4);  // strip \\?\
    if (s.startsWith("//?/")) s = s.slice(4);             // strip //?/
    s = s.replace(/\\/g, "/");
    if (s.startsWith("./")) s = s.slice(2);
    return s;
  }

  function isAbsPath(p: string): boolean {
    if (!p) return false;
    if (/^[a-zA-Z]:\//.test(p)) return true;
    if (p.startsWith("/")) return true;
    if (p.startsWith("//")) return true;
    return false;
  }

  // Case-insensitive (Windows) — strips workspace root from absolute path.
  // Returns relative path string, or null if not under root.
  function toRelUnderRoot(p: string, root: string | null): string | null {
    if (!root) return null;
    const normRoot = normalizeBatchPath(root).replace(/\/+$/, "");
    const normPath = normalizeBatchPath(p);
    const rootLower = normRoot.toLowerCase();
    const pathLower = normPath.toLowerCase();
    if (pathLower === rootLower) return "";
    if (!pathLower.startsWith(rootLower + "/")) return null;
    return normPath.slice(normRoot.length + 1);
  }

  // Normalize a path arg that may be absolute, relative, or workspace-root-prefixed.
  // Returns a clean relative path or throws if absolute and outside workspace root.
  function resolveBatchPath(rawPath: string, opName: string): string {
    let p = normalizeBatchPath(rawPath);
    if (workspaceRoot) {
      const rel = toRelUnderRoot(p, workspaceRoot);
      if (rel !== null) {
        p = rel; // was absolute-under-root → strip to relative
      } else if (isAbsPath(p)) {
        throw new Error(
          `${opName}: absolute path is outside workspace root — use a RELATIVE path instead. ` +
          `Got: "${p}", root: "${workspaceRoot}"`
        );
      }
    }
    return p;
  }

  const batchingExecutor = async (name: string, args: any): Promise<any> => {
    // Refresh workspace root each tool call (root can change mid-run from UI)
    const freshRoot = await getWorkspaceRoot();
    if (freshRoot !== workspaceRoot) {
      if (pendingWrites.length > 0) {
        throw new Error("Workspace root changed during a batch; staged writes were not committed. Retry your request.");
      }
      console.warn(`[agentic] Workspace root changed during run: ${workspaceRoot ?? "null"} -> ${freshRoot ?? "null"}`);
      workspaceRoot = freshRoot;
      batchMode = workspaceRoot != null;
    }
    // ── fs.write_file — stage, don't write immediately ───────────────────────
    if (batchMode && name === "fs.write_file") {
      const content = args?.content ?? "";
      if (!args?.path || typeof content !== "string") {
        return opts.executeTool!(name, args, opts.signal); // let it fail with a clear error
      }

      let path: string;
      try {
        path = resolveBatchPath(args.path, "fs.write_file");
      } catch (e: any) {
        appendToolLog({
          id: `tl-stage-${Date.now()}`, ts: Date.now(),
          tool: "fs.write_file [rejected]", args: { path: args.path },
          ok: false, error: e.message,
        });
        return { content: [{ type: "text", text: e.message }] };
      }

      args.path = path; // mutate so step summary shows real path

      if (!path) {
        return { content: [{ type: "text", text: "fs.write_file: resolved path is empty — provide a filename." }] };
      }
      if (isAbsPath(path)) {
        return { content: [{ type: "text", text: `fs.write_file: batch paths must be relative, got: ${path}` }] };
      }

      pendingWrites.push({ path, content });
      appendToolLog({
        id: `tl-stage-${Date.now()}`, ts: Date.now(),
        tool: "fs.write_file [staged]",
        args: { path, contentLength: content.length },
        ok: true,
      });
      return {
        content: [{ type: "text", text: `Staged: ${path} (${content.length} chars). Will be written atomically at the end.` }],
      };
    }

    // ── fs.create_directory → Tauri ws_mkdir (bypasses MCP allowed-dirs restriction) ─
    if (batchMode && name === "fs.create_directory" && args?.path) {
      let dirPath: string;
      try {
        dirPath = resolveBatchPath(args.path, "fs.create_directory");
      } catch (e: any) {
        appendToolLog({ id: `tl-mkdir-${Date.now()}`, ts: Date.now(), tool: "fs.create_directory", args: { path: args.path }, ok: false, error: e.message });
        return { content: [{ type: "text", text: e.message }] };
      }
      try {
        await invoke("ws_mkdir", { relDir: dirPath });
        appendToolLog({ id: `tl-mkdir-${Date.now()}`, ts: Date.now(), tool: "fs.create_directory", args: { path: dirPath }, ok: true });
        return { content: [{ type: "text", text: `Directory created: ${dirPath}` }] };
      } catch (e: any) {
        const errMsg = e?.message || String(e);
        appendToolLog({ id: `tl-mkdir-err-${Date.now()}`, ts: Date.now(), tool: "fs.create_directory", args: { path: dirPath }, ok: false, error: errMsg });
        return { content: [{ type: "text", text: `fs.create_directory failed: ${errMsg}` }] };
      }
    }

    // ── fs.copy_file → read source via ws_read_text, stage destination write ──
    // MCP copy might write to a location outside workspace root.
    // This version guarantees both src and dst stay within workspace root.
    if (batchMode && (name === "fs.copy_file" || name === "fs.rename_file" || name === "fs.move_file")) {
      const paths = Array.isArray(args?.paths) ? args.paths : null;
      const srcKey = args?.src ?? args?.source ?? args?.from ?? args?.oldPath ?? (paths ? paths[0] : "");
      const dstKey = args?.dst ?? args?.destination ?? args?.to ?? args?.newPath ?? (paths ? paths[1] : "");

      if (!srcKey || !dstKey) {
        return opts.executeTool!(name, args, opts.signal); // pass through if args unclear
      }

      let srcPath: string, dstPath: string;
      try {
        srcPath = resolveBatchPath(srcKey, name + ".src");
        dstPath = resolveBatchPath(dstKey, name + ".dst");
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }] };
      }

      try {
        const content = await invoke<string>("ws_read_text", { rel: srcPath });
        pendingWrites.push({ path: dstPath, content });
        appendToolLog({ id: `tl-copy-${Date.now()}`, ts: Date.now(), tool: name + " [staged]", args: { src: srcPath, dst: dstPath }, ok: true });
        return { content: [{ type: "text", text: `Staged copy: ${srcPath} → ${dstPath} (${content.length} chars). Will be written atomically.` }] };
      } catch (e: any) {
        const errMsg = e?.message || String(e);
        appendToolLog({ id: `tl-copy-err-${Date.now()}`, ts: Date.now(), tool: name, args: { src: srcPath, dst: dstPath }, ok: false, error: errMsg });
        return { content: [{ type: "text", text: `${name} failed: ${errMsg}` }] };
      }
    }

    // ── Normalize path args for ALL fs.* tools (copy, move, rename, delete, read, list)
    // Without this, the model passes relative paths that the MCP server resolves
    // against its own CWD (not the workspace root) → files land in wrong location.
    if (batchMode && name.startsWith("fs.") && workspaceRoot) {
      // All parameter keys that might carry file paths
      const pathKeys = ["path", "src", "dst", "from", "to", "source", "destination", "oldPath", "newPath"];
      let normalizedArgs = { ...args };
      const absRoot = normalizeBatchPath(workspaceRoot).replace(/\/+$/, "");
      for (const key of pathKeys) {
        if (typeof normalizedArgs[key] === "string" && normalizedArgs[key]) {
          const raw = normalizedArgs[key] as string;
          const n = normalizeBatchPath(raw);
          // If it's a bare relative path, prepend workspace root so MCP can find it
          if (!isAbsPath(n)) {
            normalizedArgs[key] = absRoot + "/" + n;
          } else {
            const rel = toRelUnderRoot(n, workspaceRoot);
            if (rel === null) {
              throw new Error(`${name}: absolute path is outside workspace root  use a RELATIVE path instead. Got: "${n}", root: "${absRoot}"`);
            }
            normalizedArgs[key] = absRoot + "/" + rel;
          }
        }
      }
      return opts.executeTool!(name, normalizedArgs, opts.signal);
    }

    return opts.executeTool!(name, args, opts.signal);
  };

  // catalog already loaded from tool cache above
  const steps: StepRecord[] = [];
  let consecutiveParseFailures = 0;
  const toolArgErrorOnce = new Set<string>();
  
  // ── Loop Guard ────────────────────────────────────────────────────────────
  // Detects repeated tool patterns that indicate infinite reasoning loops.
  const loopGuard: LoopGuardState = createLoopGuard();

  // ── Circuit breaker ───────────────────────────────────────────────────────
  // If the same tool fails N times in a row, block it for the rest of the run.
  // Prevents the model from burning all remaining steps on a broken tool.
  const toolFailCount = new Map<string, number>();
  const CIRCUIT_BREAK_THRESHOLD = 2;
  const circuitBroken = new Set<string>();

  function recordToolFailure(toolName: string) {
    const n = (toolFailCount.get(toolName) ?? 0) + 1;
    toolFailCount.set(toolName, n);
    if (n >= CIRCUIT_BREAK_THRESHOLD) {
      circuitBroken.add(toolName);
      console.warn(`[agentic] circuit breaker: blocking "${toolName}" after ${n} failures`);
    }
  }
  function recordToolSuccess(toolName: string) {
    toolFailCount.set(toolName, 0); // reset on success
  }

  // ── V5: Semantic executor ─────────────────────────────────────────────────
  // Wraps batchingExecutor. Intercepts "semantic.find" and handles it locally
  // using the pre-built index + Ollama embeddings. All other tool calls pass
  // through to batchingExecutor → MCP unchanged.
  const semanticExecutor = async (name: string, args: any): Promise<any> => {
    // ── memory.add_fact — writes to localStorage synchronously ───────────────
    if (name === "memory.add_fact") {
      const text = String(args?.text ?? "").trim();
      if (!text) {
        return { content: [{ type: "text", text: "memory.add_fact: 'text' argument is required." }] };
      }
      if (!workspaceRoot) {
        return { content: [{ type: "text", text: "memory.add_fact: no workspace root set — cannot save fact." }] };
      }
      try {
        const fact = addFact(workspaceRoot, text, "agent");
        return { content: [{ type: "text", text: `Saved to memory (id: ${fact.id}): "${text}"` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `memory.add_fact failed: ${e?.message || String(e)}` }] };
      }
    }

    if (name === "semantic.find") {
      const query = String(args?.query ?? "").trim();
      const topK  = Math.min(Number(args?.top_k ?? 5), 10);

      if (!query) {
        return { content: [{ type: "text", text: "semantic.find: query must be a non-empty string." }] };
      }
      if (!semanticIndex || !hasSemanticIndex) {
        return { content: [{ type: "text", text: "No semantic index available. Use fs.search_files or ask the user to build the index in the Workspace panel." }] };
      }
      try {
        const results = await searchIndex(query, opts.baseUrl, semanticIndex, topK);
        return { content: [{ type: "text", text: formatSearchResults(results) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `semantic.find error: ${e?.message || String(e)}` }] };
      }
    }
    return batchingExecutor(name, args);
  };

  // ── Agentic loop ──────────────────────────────────────────────────────────

  for (let step = 1; step <= maxSteps; step++) {
    // ── Step Timeout Check ──────────────────────────────────────────────────
    // Prevent hanging steps with timeout check.
    const stepStart = Date.now();

    if (opts.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

    // ── Record step for metrics ─────────────────────────────────────────────
    incrementStep();

    // Filter to only relevant tools for this prompt
    // Reduces token usage and prevents tool hallucination
    const userPrompt = opts.prompt ?? opts.messages?.[opts.messages.length - 1]?.content ?? "";
    const filteredTools = filterToolsForPrompt(toolCatalogCache.tools, userPrompt);
    
    const plannerSystem = buildPlannerSystem(
      toolCatalog(filteredTools, hasSemanticIndex, batchMode),
      step, maxSteps, batchMode, memoryText
    );

    opts.onStatus?.(`🤔 Planning step ${step}…`);

    // ── Priority 2: Trim context before each planner call ──────────────────
    // Prevents context window overflow on long multi-step tasks. The original
    // user goal (first messages) is always preserved; only old tool results
    // are dropped, keeping the most recent KEEP_LAST_TOOL_RESULTS results.
    const trimmedConvo = trimContext(convo);
    const droppedCount = convo.length - trimmedConvo.length;
    if (droppedCount > 0) {
      console.log(`[agentic] Context trimmed: dropped ${droppedCount} old messages (${convo.length} → ${trimmedConvo.length})`);
    }

    // ── Retry logic with exponential backoff ───────────────────────────────
    // Transient LLM failures (network glitches, model restarts, provider errors)
    // should not immediately abort the agent run. Retry up to 3 times with
    // increasing delays before giving up.
    const MAX_LLM_RETRIES = 3;
    const backoffDelays = [0, 1000, 3000]; // attempt 1 → immediate, 2 → 1s, 3 → 3s

    let planText: string = "";
    let lastLlmError: any = null;

    for (let llmAttempt = 1; llmAttempt <= MAX_LLM_RETRIES; llmAttempt++) {
      try {
        if (llmAttempt > 1) {
          opts.onStatus?.(`🔄 LLM retry ${llmAttempt}/${MAX_LLM_RETRIES}…`);
          // Wait for backoff delay (except first retry which is immediate)
          if (backoffDelays[llmAttempt - 1] > 0) {
            await new Promise(resolve => setTimeout(resolve, backoffDelays[llmAttempt - 1]));
          }
        }

        planText = opts.chatFn
          ? await opts.chatFn([plannerSystem, ...trimmedConvo], opts.signal)
          : await ollamaChat({
              baseUrl: opts.baseUrl,
              model: opts.plannerModel || opts.model,
              messages: [plannerSystem, ...trimmedConvo],
              signal: opts.signal,
            });

        // Success — break out of retry loop
        lastLlmError = null;
        break;
      } catch (e: any) {
        // StreamTimeoutError = Ollama timed out producing a response.
        // This is NOT a retryable LLM error — retrying will just
        // timeout again. Exit the retry loop immediately.
        if (e instanceof StreamTimeoutError) {
          console.warn("[AGENT] stream timeout — exiting retry loop immediately");
          lastLlmError = e;
          break;
        }

        lastLlmError = e;
        if (e?.name === "AbortError") throw e; // Don't retry abort errors

        // If this was the last attempt, exit retry loop with error
        if (llmAttempt === MAX_LLM_RETRIES) {
          break;
        }
        // Otherwise, continue to next retry attempt
      }
    }

    // If all retries failed, report error and break
    if (lastLlmError) {
      convo.push({ role: "assistant", content: `[planner error] ${lastLlmError?.message || String(lastLlmError)}` });
      break;
    }

    opts.onStatus?.("");

    let plan = parsePlan(planText);

    if (!plan) {
      // If the empty plan is because of a stream timeout,
      // do NOT retry — we would just timeout again.
      // Break immediately and let the agent produce a fallback answer.
      if (planText === "" && lastLlmError instanceof StreamTimeoutError) {
        console.warn("[AGENT] parse failure caused by stream timeout — skipping parse retries");
        convo.push({
          role: "assistant",
          content: "[planner] Stream timed out. Proceeding to answer directly.",
        });
        break;
      }

      consecutiveParseFailures++;
      if (consecutiveParseFailures > MAX_PLAN_PARSE_RETRIES) {
        convo.push({
          role: "assistant",
          content: `[planner] Could not produce valid JSON after ${MAX_PLAN_PARSE_RETRIES} retries. Proceeding to answer.`,
        });
        break;
      }
      convo.push({
        role: "user",
        content:
          `Your previous response was not valid JSON:\n${(planText || "(empty response)").slice(0, 300)}\n\n` +
          `Respond with ONLY a JSON object. No other text. Try again.`,
      });
      step--;
      continue;
    }

    consecutiveParseFailures = 0;

    if (plan.action === "final") break;

    // ── Plan Verification ───────────────────────────────────────────────────
    // Validate plan structure before executing to catch malformed plans early.
    const firstUserMsg = opts.messages.find((m) => m.role === "user");
    const verification = await verifyPlan(plan, firstUserMsg?.content || "");

    if (!verification.valid) {
      console.warn(`[agentic] invalid plan: ${verification.reason}`);

      convo.push({
        role: "assistant",
        content: `[plan review] Plan invalid: ${verification.reason}. Revising approach.`,
      });
      continue;
    }

    // ── Tool name aliasing ────────────────────────────────────────────────
    // Resolve bare names (list_directory) → qualified (fs.list_directory).
    // Do this before any other checks so blocklist/circuit-breaker use real name.
    const resolvedName = resolveToolName(plan.name, tools, aliasMap);
    if (resolvedName !== plan.name) {
      console.log(`[agentic] alias: "${plan.name}" → "${resolvedName}"`);
    }
    const toolName = resolvedName;

    // ── Circuit breaker ───────────────────────────────────────────────────
    if (circuitBroken.has(toolName)) {
      convo.push({
        role: "assistant",
        content: `[tool blocked] "${toolName}" has failed ${CIRCUIT_BREAK_THRESHOLD} times and is blocked for this run. Use a different approach.`,
      });
      continue;
    }

    if (!isAgentTool(toolName, tools)) {
      convo.push({
        role: "assistant",
        content: `[tool blocked] "${toolName}" is not in the allowed tools list. ` +
          `Only explicitly permitted tools can be executed. ` +
          `Available tools: ${tools.length} MCP tools loaded`,
      });
      continue;
    }

    // Synthetic tools handled by semanticExecutor — not in the MCP tool list
    const isSynthetic = toolName === "semantic.find" || toolName === "memory.add_fact";

    // ── Self-heal: tool not found → try hub.refresh once ─────────────────
    if (!isSynthetic && !tools.some((t) => t.name === toolName)) {
      opts.onStatus?.("🔄 Tool not found — refreshing hub…");
      try {
        await semanticExecutor("hub.refresh", {});
        const refreshed = await getCachedTools();
        if (refreshed.tools.length > 0) {
          tools = refreshed.tools;
          aliasMap = buildToolAliasMap(tools);
        }
      } catch { /* best-effort */ }
      opts.onStatus?.("");

      // Re-check after refresh
      if (!tools.some((t) => t.name === toolName)) {
        convo.push({
          role: "assistant",
          content: `[tool not found] "${toolName}" does not exist even after hub refresh. Available tools: ${tools.slice(0, 8).map((t) => t.name).join(", ")}`,
        });
        continue;
      }
    }

    const normalized = normalizeToolArgs(toolName, plan.args);
    if (normalized.error) {
      const errText = normalized.error;
      const errKey = `${toolName}:${errText}`;
      if (!toolArgErrorOnce.has(errKey)) {
        toolArgErrorOnce.add(errKey);
        convo.push({
          role: "assistant",
          content: `[tool error: ${toolName}]\n${errText}\n\nPlease correct the tool arguments and try again.`,
        });
      }
      recordToolFailure(toolName);
      steps.push({
        tool: toolName,
        args: normalized.args,
        ok: false,
        summary: humanSummary(toolName, normalized.args, false, errText),
      });
      continue;
    }

    const toolArgs = normalized.args;

    // ── Reasoning Stabilizer ────────────────────────────────────────────────
    // Require the agent to explain why the tool is needed before executing.
    // This reduces premature tool calls and improves decision quality.
    const planReasoning = plan.reasoning;

    // ── Execution Trace: Record decision before execution ───────────────────
    executionTrace.push({
      step,
      reasoning: planReasoning || "",
      tool: toolName,
      args: toolArgs,
    });

    if (!planReasoning || planReasoning.trim().length === 0) {
      console.warn(`[agentic] tool missing reasoning: ${toolName}`);
      
      // Record metric for observability
      recordReasoningLength(0);
      
      // Ask agent to provide reasoning
      convo.push({
        role: "assistant",
        content: `[system] Reasoning required. Explain why "${toolName}" is needed before executing it. ` +
          `What information are you trying to gather? How does this help answer the user's request?`,
      });
      
      // Skip this tool and continue reasoning
      continue;
    }
    
    // Validate reasoning length
    if (planReasoning.length < MIN_REASONING_LENGTH) {
      console.warn(
        `[agentic] tool reasoning too short: ${toolName} (${planReasoning.length} chars < ${MIN_REASONING_LENGTH})`
      );
      
      // Record metric for observability
      recordReasoningLength(planReasoning.length);
      
      // Ask agent to elaborate
      convo.push({
        role: "assistant",
        content: `[system] Reasoning too brief (${planReasoning.length} chars). ` +
          `Please elaborate on why "${toolName}" is needed. ` +
          `Explain your reasoning in more detail before executing.`,
      });
      
      // Skip this tool and continue reasoning
      continue;
    }
    
    // Log reasoning for debugging
    console.log(`[agentic] reasoning for ${toolName}: ${planReasoning}`);

    // Record metric for observability
    recordReasoningLength(planReasoning.length);

    // ── Tool Budget Check ───────────────────────────────────────────────────
    // Verify we have budget remaining before executing the tool.
    if (toolBudget <= 0) {
      console.warn(`[agentic] tool budget exhausted: cannot execute ${toolName}`);

      // Record metric for observability
      recordToolBudgetRemaining(0);

      // Add system message to inform agent
      convo.push({
        role: "assistant",
        content: `[system] Tool usage limit reached. Continue reasoning without additional tool calls. ` +
          `You have used your allocated tool budget. Provide your final answer based on information gathered so far.`,
      });

      // Skip this tool and continue reasoning
      continue;
    }

    // ── Tool Confidence Gate ────────────────────────────────────────────────
    // Check if the agent is confident enough in this tool call.
    // Low confidence indicates the agent may be guessing.
    const planConfidence = plan.confidence ?? DEFAULT_CONFIDENCE;
    
    if (planConfidence < TOOL_CONFIDENCE_THRESHOLD) {
      console.warn(
        `[agentic] tool confidence too low: ${toolName} (${planConfidence.toFixed(2)} < ${TOOL_CONFIDENCE_THRESHOLD})`
      );
      
      // Record metric for observability
      recordLowConfidenceTool(toolName, planConfidence);
      
      // Add system message to prompt reconsideration
      convo.push({
        role: "assistant",
        content: `[system] Tool confidence too low (${planConfidence.toFixed(2)}). ` +
          `Reconsider reasoning before executing "${toolName}". ` +
          `Do you have enough context? Should you gather more information first?`,
      });
      
      // Skip this tool and continue reasoning
      continue;
    }

    // ── Catalog Version Sync ────────────────────────────────────────────────
    // Verify catalog hasn't changed since we loaded it. If version differs,
    // refresh tools and aliasMap to stay in sync.
    const latestCatalog = await getToolCatalog();
    if (latestCatalog.version !== catalogVersion) {
      console.warn(
        `[agentic] tool catalog version changed (${catalogVersion} → ${latestCatalog.version}), ` +
        `refreshing alias map`
      );
      toolCatalogCache = latestCatalog;
      catalogVersion = latestCatalog.version;
      tools = toolCatalogCache.tools;
      aliasMap = toolCatalogCache.aliasMap;
    }

    // ── Loop Guard: Record tool before execution ────────────────────────────
    recordTool(loopGuard, toolName, toolArgs);

    // Check for loop pattern
    const loopCheck = detectLoop(loopGuard);
    if (loopCheck.loopDetected) {
      console.warn(`[agentic] loop detected: ${loopCheck.reason}`);

      // Add system message to conversation
      convo.push({
        role: "assistant",
        content: `[system] Agent loop guard triggered.\n\n` +
          `Execution stopped to prevent infinite loop.\n\n` +
          `Reason: ${loopCheck.reason}\n\n` +
          `The agent appears to be stuck in a repeated pattern. ` +
          `Try rephrasing your request or providing more specific guidance.`,
      });

      // Terminate the run
      break;
    }

    // ── Tool Result Cache: Check for cached result ──────────────────────────
    const cacheKey = getToolCacheKey(toolName, toolArgs);
    let result: any;
    
    if (toolResultCache.has(cacheKey)) {
      console.log(`[agentic] cache hit: ${toolName} (same args)`);
      result = toolResultCache.get(cacheKey);
    } else {
      // Execute tool and cache result
      result = await runTool({
        toolName,
        args:     toolArgs,
        exec:     semanticExecutor,
        onStatus: opts.onStatus,
        signal:   opts.signal,
      });

      // Cache the result (only if successful)
      if (result.ok) {
        toolResultCache.set(cacheKey, result);
        invalidateToolCacheOnWrite(toolName); // clear cache if this was a write
      }
    }

    // ── Tool Reflection ──────────────────────────────────────────────────────
    // Evaluate tool result to help agent understand what happened.
    try {
      const reflection = await reflectOnToolResult(
        toolName,
        JSON.stringify(result).slice(0, 2000),
        async (msgs) => {
          const reflectionPlanText = opts.chatFn
            ? await opts.chatFn(msgs, opts.signal)
            : await ollamaChat({
                baseUrl: opts.baseUrl,
                model: opts.plannerModel || opts.model,
                messages: msgs,
                signal: opts.signal,
              });
          return reflectionPlanText;
        }
      );

      if (reflection) {
        console.log("[agentic reflection]", reflection);
      }

    } catch (err) {
      console.warn("[agentic] reflection skipped", err);
    }

    // ── Record tool usage for metrics ───────────────────────────────────────
    recordToolUsage(toolName);

    // ── Execution Trace: Record result summary ──────────────────────────────
    const traceIndex = executionTrace.length - 1;
    if (traceIndex >= 0 && executionTrace[traceIndex]) {
      const resultSummary = typeof result === "string"
        ? result.slice(0, 200)
        : JSON.stringify(result).slice(0, 200);
      executionTrace[traceIndex].resultSummary = resultSummary;
    }

    if (toolName === "hub.refresh" && result.ok) {
      const refreshed = await getCachedTools();
      if (refreshed.tools.length > 0) {
        tools = refreshed.tools;
        aliasMap = buildToolAliasMap(tools);
      }
    }

    // Circuit breaker tracking
    if (result.ok) {
      recordToolSuccess(toolName);
      // Decrement tool budget after successful execution
      toolBudget--;
      console.log(`[agentic] tool budget remaining: ${toolBudget}`);
    } else {
      recordToolFailure(toolName);
    }

    steps.push({
      tool: toolName,
      args: toolArgs,
      ok: result.ok,
      summary: humanSummary(toolName, toolArgs, result.ok, result.text),
    });

    // Append to FULL convo (not trimmed) — trimContext will manage what
    // gets sent to the planner on the next iteration
    convo.push({
      role: "assistant",
      content: result.ok
        ? `[tool result: ${toolName}]\n${result.text}`
        : `[tool error: ${toolName}]\n${result.text}\n\nNote: this failed. Choose a different approach.`,
    });

    // ── Persist step state for recovery ─────────────────────────────────────
    // Save after each step so we can recover from crashes/UI reloads.
    // Only stores minimal info (not full conversation to avoid quota issues).
    saveAgentRunState({
      step,
      lastTool: toolName,
      lastToolArgs: toolArgs,
      lastToolOk: result.ok,
    });

    // ── Step Timeout Check ──────────────────────────────────────────────────
    // Check if step has exceeded timeout after completion.
    if (Date.now() - stepStart > MAX_AGENT_STEP_TIME) {
      console.warn("[agentic] step timeout exceeded");
      convo.push({
        role: "assistant",
        content: `[system] Agent step timeout reached. Stopping execution to prevent hanging. ` +
          `Step ${step} took ${(Date.now() - stepStart) / 1000}s (limit: ${MAX_AGENT_STEP_TIME / 1000}s).`,
      });
      break;
    }
  }

  // ── Atomic batch commit ───────────────────────────────────────────────────

  if (pendingWrites.length > 0) {
    if (opts.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

    const freshRoot = await getWorkspaceRoot();
    if (freshRoot !== workspaceRoot) {
      console.warn("[agentic] Workspace root changed before commit; skipping batch commit.");
      steps.push({
        tool: "batch_commit",
        args: { files: pendingWrites.map((w) => w.path) },
        ok: false,
        summary: "✗ Workspace root changed before commit; staged writes were not committed.",
      });
      opts.onToken("\n\n⚠️ Workspace root changed before commit; staged writes were not committed. Retry your request.\n\n");
      saveAgentRunState({ status: "failed" });
      return;
    }

    const commitResult = await commitBatch(pendingWrites, opts.onStatus);

    if (commitResult.ok) {
      const { batch_id, applied } = commitResult.result;

      // Clear cache after batch commit so subsequent reads see fresh state
      invalidateToolCacheOnWrite("batch_commit");

      // ── Verify each file was actually written ─────────────────────────────
      let verifyError: string | null = null;
      for (const w of pendingWrites) {
        try {
          const read = await invoke<string>("ws_read_text", { rel: w.path });
          if (read !== w.content) {
            verifyError = `Content mismatch: ${w.path}`;
            break;
          }
        } catch (e: any) {
          verifyError = `Read-back failed: ${w.path} (${e?.message || String(e)})`;
          break;
        }
      }

      if (verifyError) {
        const rb = await rollbackBatch(batch_id, opts.onStatus);
        const rbMsg = rb
          ? `Rolled back: ${rb.restored} file(s) restored, ${rb.deleted} new file(s) removed.`
          : "⚠️ Rollback also failed — check workspace manually.";

        steps.push({
          tool: "batch_commit",
          args: { files: pendingWrites.map((w) => w.path) },
          ok: false,
          summary: `✗ Verification failed: ${verifyError}. ${rbMsg}`,
        });

        opts.onToken(
          `

⚠️ **Write verification failed — rollback executed.**

` +
          `**Error:** ${verifyError}

` +
          `**${rbMsg}**

`
        );
      } else {
        steps.push({
          tool: "batch_commit",
          args: { files: pendingWrites.map((w) => w.path) },
          ok: true,
          summary: `✓ Committed ${applied} file(s) atomically (batch ID: ${batch_id})`,
        });

        // Notify WorkspacePanel to auto-refresh its file list and highlight written files.
        // Uses a plain window CustomEvent — no Tauri required, works in both dev and prod.
        window.dispatchEvent(new CustomEvent("nikolai:batch-committed", {
          detail: {
            batch_id,
            applied,
            files: pendingWrites.map((w) => w.path),
          },
        }));
      }
    } else {
      const rb = await rollbackBatch(null, opts.onStatus);
      const rbMsg = rb
        ? `Rolled back: ${rb.restored} file(s) restored, ${rb.deleted} new file(s) removed.`
        : "⚠️ Rollback also failed — check your workspace manually.";

      steps.push({
        tool: "batch_commit",
        args: {},
        ok: false,
        summary: `✗ Commit failed: ${commitResult.error}. ${rbMsg}`,
      });

      opts.onToken(
        `\n\n⚠️ **Batch write failed — no files were permanently changed.**\n\n` +
        `**Error:** ${commitResult.error}\n\n` +
        `**${rbMsg}**\n\n`
      );
    }
  } else if (!batchMode) {
    steps.push({
      tool: "batch_commit",
      args: {},
      ok: true,
      summary: "✓ Batch mode off (direct writes); no atomic commit required.",
    });
  } else {
    console.warn("[agentic] No pending writes to commit (staging likely failed).");
    steps.push({
      tool: "batch_commit",
      args: { files: [] },
      ok: false,
      summary: "✗ No files were staged, so nothing was committed. Check earlier path errors.",
    });
    opts.onToken("\n\n⚠️ No files were staged, so nothing was committed. Check the earlier fs.write_file errors above.\n\n");
  }

  // ── Final streaming answer ────────────────────────────────────────────────

  if (opts.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

  if (steps.length > 0) {
    // Serialize steps — append ||{json} metadata so ChatCenter can show
    // expanded diffs without an extra IPC call. The || separator is safe
    // because humanSummary() never produces that character.
    const lines = steps.map((s) => {
      const meta: Record<string, any> = {};

      // File path — present for most fs.* tools
      if (typeof s.args?.path === "string" && s.args.path)
        meta.path = s.args.path;

      // Write content — what the agent actually wrote (first 2000 chars)
      if (
        (s.tool === "fs.write_file" || s.tool === "fs.edit_file") &&
        typeof s.args?.content === "string"
      ) {
        meta.contentPreview = s.args.content.slice(0, 2000);
        meta.contentLength  = s.args.content.length;
        meta.truncated      = s.args.content.length > 2000;
      }

      // Batch commit — list of written files
      if (s.tool === "batch_commit" && Array.isArray(s.args?.files))
        meta.files = s.args.files;

      const suffix = Object.keys(meta).length > 0 ? `||${JSON.stringify(meta)}` : "";
      return `- ${s.summary}${suffix}`;
    }).join("\n");

    opts.onToken(`**Actions taken:**\n${lines}\n\n---\n\n`);
  }

  const finalSystem: OllamaMsg = {
    role: "system",
    content:
      `You are a helpful assistant summarising completed tool work.\n` +
      `The tools have already run. The results are in the conversation above.\n` +
      `CRITICAL: Base your answer ONLY on what the tool results actually showed.\n` +
      `Do NOT say the workspace has no filesystem — tool results prove it does.\n` +
      `Do NOT say files don't exist if a tool successfully read or listed them.\n` +
      `Do NOT output JSON. Do NOT suggest running tools again.\n` +
      `If a batch commit succeeded, list which files were written and their paths.\n` +
      `If something failed, explain concretely what failed and offer alternatives.\n` +
      `Be specific: reference actual filenames, paths, and content you found.`,
  };

  // Use trimmed context for final answer too — avoids overloading the model
  // with all the tool results again (the steps summary covers them)
  const finalConvo = trimContext(convo);

  if (opts.streamFn) {
    await opts.streamFn([finalSystem, ...finalConvo], opts.signal, opts.onToken);
  } else {
    await ollamaStreamChat({
      baseUrl: opts.baseUrl,
      model: opts.model,
      messages: [finalSystem, ...finalConvo],
      signal: opts.signal,
      onToken: opts.onToken,
    });
  }

  // ── Log execution trace for debugging ─────────────────────────────────────
  console.log("[agentic] execution trace:", executionTrace);

  // ── Mark run as completed ─────────────────────────────────────────────────
  markAgentRunComplete();

  // ── Finish metrics tracking ──────────────────────────────────────────────
  finishAgentMetrics();
}
