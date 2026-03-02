import { invoke } from "@tauri-apps/api/tauri";
import { ollamaChat, type OllamaMsg } from "./ollamaChat";
import { ollamaStreamChat } from "./ollamaStream";
import { mcpListTools, getCachedTools, type McpTool } from "./mcp";
import { appendToolLog } from "./toolLog";
import { formatToolResult } from "./toolResult";
import { loadMemory, formatMemoryForPrompt, addFact } from "./memory";
import { loadIndex, searchIndex, formatSearchResults, type SemanticIndex } from "./semanticIndex";

// ── Types ─────────────────────────────────────────────────────────────────────

type Plan =
  | { action: "tool"; name: string; args: any }
  | { action: "final"; content: string };

type StepRecord = {
  tool: string;
  args: any;
  ok: boolean;
  summary: string;
};

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

// ── Priority 2: Context window constants ──────────────────────────────────────
//
// After N tool steps the conversation accumulates thousands of characters.
// With an 8B model this silently truncates the beginning of context — the
// model "forgets" the original goal and starts going off-track.
//
// We keep: all original user messages (the goal) + last KEEP_LAST_TOOL_RESULTS
// tool exchange messages. Everything older is dropped.
//
const MAX_CONTEXT_CHARS     = 12_000; // ~3000 tokens — safe headroom for most 8B models
const KEEP_LAST_TOOL_RESULTS = 8;     // keep last 8 tool results — enough for 9-file tasks to remember all staged writes

// ── Tool blocklist ────────────────────────────────────────────────────────────

const BLOCKED_TOOL_PATTERNS: RegExp[] = [
  /^doc-suite\.doc_suite\.(email_send|sms_send|webhook_post|http_request)/i,
  /^doc-suite\.doc_suite\.oauth/i,
];

function isAgentTool(name: string): boolean {
  return !BLOCKED_TOOL_PATTERNS.some((p) => p.test(name));
}

// ── Tauri guard ───────────────────────────────────────────────────────────────

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

function trimContext(convo: OllamaMsg[]): OllamaMsg[] {
  // Find where tool exchange starts
  const firstToolIdx = convo.findIndex(isToolExchangeMessage);
  if (firstToolIdx < 0) return convo; // no tool messages yet — nothing to trim

  const originalMsgs  = convo.slice(0, firstToolIdx);
  const toolExchange  = convo.slice(firstToolIdx);

  // Keep only the last KEEP_LAST_TOOL_RESULTS tool exchange messages
  const kept = toolExchange.length > KEEP_LAST_TOOL_RESULTS
    ? toolExchange.slice(-KEEP_LAST_TOOL_RESULTS)
    : toolExchange;

  const trimmed = [...originalMsgs, ...kept];

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

function parsePlan(raw: string): Plan | null {
  const cleaned = stripCodeFences(raw);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const obj: any = JSON.parse(cleaned.slice(start, end + 1));
    if (obj?.action === "tool" && typeof obj?.name === "string") {
      return { action: "tool", name: obj.name, args: obj.args ?? {} };
    }
    if (obj?.action === "final" && typeof obj?.content === "string") {
      return { action: "final", content: obj.content };
    }
    return null;
  } catch {
    return null;
  }
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

  const allowed = (tools || []).filter((t) => isAgentTool(t.name));
  for (const t of allowed) {
    lines.push(`- ${t.name}${t.description ? ` — ${t.description}` : ""}`);
  }

  return lines.length > 0 ? lines.join("\n") : "(no tools available)";
}

// ── Core single-tool runner ───────────────────────────────────────────────────

async function runTool(opts: {
  toolName: string;
  args: any;
  exec: (name: string, args: any) => Promise<any>;
  onStatus?: (s: string) => void;
}): Promise<{ ok: boolean; text: string }> {
  opts.onStatus?.(humanStatus(opts.toolName, opts.args));

  try {
    const out = await opts.exec(opts.toolName, opts.args ?? {});
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
      `Rules:\n` +
      `- Output JSON only. Any prose = invalid.\n` +
      `- Use "final" when you have enough to answer or all writes are planned.\n` +
      `- NEVER invent file contents — use fs.read_file first.\n` +
      `- NEVER guess directory listings — use fs.list_directory first.\n` +
      `- Avoid node_modules, .git, dist, build directories.\n\n` +
      `Example:  {"action":"tool","name":"fs.read_file","args":{"path":"src/App.tsx"}}\n` +
      `Example:  {"action":"final","content":"Done."}\n\n` +
      `Available tools:\n${catalog}`,
  };
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
  executeTool?: (name: string, args: any) => Promise<any>;
  plannerModel?: string;
  // Optional overrides — allows non-Ollama providers (Anthropic, OpenAI, etc.)
  // to drive the agentic loop. When omitted, defaults to ollamaChat/ollamaStreamChat.
  chatFn?: (messages: OllamaMsg[], signal: AbortSignal) => Promise<string>;
  streamFn?: (messages: OllamaMsg[], signal: AbortSignal, onToken: (t: string) => void) => Promise<void>;
}): Promise<void> {
  const maxSteps = opts.maxSteps ?? 10;

  if (!opts.executeTool) {
    opts.onToken(`\n\n[agent] No tool executor provided. Tool calls are blocked.\n`);
    return;
  }

  // Use the in-memory tool cache — no MCP round-trip on every agentic request.
  // Falls back to a live fetch only if the cache is empty (first run / reconnect).
  let tools: McpTool[] = getCachedTools();
  if (tools.length === 0) {
    try {
      tools = await mcpListTools();
    } catch (e: any) {
      opts.onToken(
        `\n\n[agent] MCP not connected (${e?.message || String(e)}). ` +
        `Go to Settings → Tools → Connect first.\n`
      );
      return;
    }
  }

  if (tools.length === 0) {
    opts.onToken(
      `\n\n[agent] No tools loaded yet. Go to Settings → Tools → Connect ` +
      `and wait for the tool list to populate, then try again.\n`
    );
    return;
  }

  // Determine batch mode (workspace root required)
  let workspaceRoot = await getWorkspaceRoot();
  let batchMode = workspaceRoot != null;
  const pendingWrites: PendingWrite[] = [];

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
        return opts.executeTool!(name, args); // let it fail with a clear error
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
      // Show live count so user sees progress on multi-file tasks
      opts.onStatus?.(`💾 ${pendingWrites.length} file(s) staged…`);
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
      const srcArg = Object.keys(args).find(k => ["src","source","from","oldPath"].includes(k));
      const dstArg = Object.keys(args).find(k => ["dst","destination","to","newPath"].includes(k));

      if (!srcKey || !dstKey) {
        return opts.executeTool!(name, args); // pass through if args unclear
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
      return opts.executeTool!(name, normalizedArgs);
    }

    return opts.executeTool!(name, args);
  };

  const catalog = toolCatalog(tools, hasSemanticIndex, batchMode);
  const steps: StepRecord[] = [];
  let consecutiveParseFailures = 0;

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
    if (opts.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

    const plannerSystem = buildPlannerSystem(catalog, step, maxSteps, batchMode, memoryText);

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

    let planText: string;
    try {
      planText = opts.chatFn
        ? await opts.chatFn([plannerSystem, ...trimmedConvo], opts.signal)
        : await ollamaChat({
            baseUrl: opts.baseUrl,
            model: opts.plannerModel || opts.model,
            messages: [plannerSystem, ...trimmedConvo],
            signal: opts.signal,
          });
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      convo.push({ role: "assistant", content: `[planner error] ${e?.message || String(e)}` });
      break;
    } finally {
      opts.onStatus?.("");
    }

    let plan = parsePlan(planText);

    if (!plan) {
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
          `Your previous response was not valid JSON:\n${planText.slice(0, 300)}\n\n` +
          `Respond with ONLY a JSON object. No other text. Try again.`,
      });
      step--;
      continue;
    }

    consecutiveParseFailures = 0;

    if (plan.action === "final") break;

    const toolName = plan.name;

    if (!isAgentTool(toolName)) {
      convo.push({ role: "assistant", content: `[tool blocked] "${toolName}" is not available.` });
      continue;
    }

    // Synthetic tools handled by semanticExecutor — not in the MCP tool list
    const isSynthetic = toolName === "semantic.find" || toolName === "memory.add_fact";
    if (!isSynthetic && !tools.some((t) => t.name === toolName)) {
      convo.push({ role: "assistant", content: `[tool not found] "${toolName}" does not exist. Choose from the available tools list.` });
      continue;
    }

    const result = await runTool({
      toolName,
      args:     plan.args ?? {},
      exec:     semanticExecutor,   // ← V5: wraps batchingExecutor, intercepts semantic.find
      onStatus: opts.onStatus,
    });

    steps.push({
      tool: toolName,
      args: plan.args ?? {},
      ok: result.ok,
      summary: humanSummary(toolName, plan.args, result.ok, result.text),
    });

    // Append to FULL convo (not trimmed) — trimContext will manage what
    // gets sent to the planner on the next iteration
    convo.push({
      role: "assistant",
      content: result.ok
        ? `[tool result: ${toolName}]\n${result.text}`
        : `[tool error: ${toolName}]\n${result.text}\n\nNote: this failed. Choose a different approach.`,
    });
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
      return;
    }

    const commitResult = await commitBatch(pendingWrites, opts.onStatus);

    if (commitResult.ok) {
      const { batch_id, applied } = commitResult.result;

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
  } else if (batchMode) {
    // batchMode is ON but nothing was staged — likely the model chose read-only
    // tools only, OR all fs.write_file calls failed path validation.
    // Only warn in batch mode; if batchMode is false, writes went through MCP
    // directly and no commit was needed — no warning required.
    const hadWriteAttempt = steps.some((s) =>
      s.tool === "fs.write_file" || s.tool.startsWith("fs.write_file")
    );
    if (hadWriteAttempt) {
      console.warn("[agentic] fs.write_file was called but nothing was staged (path error).");
      steps.push({
        tool: "batch_commit",
        args: { files: [] },
        ok: false,
        summary: "✗ No files were staged — check the fs.write_file path errors above.",
      });
      opts.onToken("\n\n⚠️ **No files were staged** — all `fs.write_file` calls failed path validation. Check the action steps above.\n\n");
    }
    // If no write was attempted (read-only task) — stay silent, no commit needed.
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
}
