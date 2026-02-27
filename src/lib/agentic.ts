import { invoke } from "@tauri-apps/api/tauri";
import { ollamaChat, type OllamaMsg } from "./ollamaChat";
import { ollamaStreamChat } from "./ollamaStream";
import { mcpListTools, getCachedTools, type McpTool } from "./mcp";
import { appendToolLog } from "./toolLog";
import { formatToolResult } from "./toolResult";

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
const MAX_CONTEXT_CHARS     = 10_000; // ~2500 tokens — safe headroom for most 8B models
const KEEP_LAST_TOOL_RESULTS = 4;     // keep last 4 tool result messages

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
  return typeof window !== "undefined" && (window as any).__TAURI__ != null;
}

// ── Workspace root check ──────────────────────────────────────────────────────

async function getWorkspaceRoot(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("ws_get_root");
  } catch {
    return null;
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
      batchId: batchId ?? null,
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
  if (toolName === "fs.write_file")
    return `${icon} Staged ${short(a.path ?? "file")} for batch write`;
  if (toolName === "fs.edit_file")
    return `${icon} Edited ${short(a.path ?? "file")}`;
  if (toolName === "fs.list_directory")
    return `${icon} Listed ${short(a.path ?? "directory")}`;
  if (toolName === "fs.search_files")
    return `${icon} Searched "${short(a.query ?? "")}"`;
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

function toolCatalog(tools: McpTool[]): string {
  const allowed = (tools || []).filter((t) => isAgentTool(t.name));
  if (allowed.length === 0) return "(no tools available)";
  return allowed
    .map((t) => `- ${t.name}${t.description ? ` — ${t.description}` : ""}`)
    .join("\n");
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
): OllamaMsg {
  const batchNote = batchMode
    ? `\nBATCH MODE ACTIVE: fs.write_file calls are staged in memory and committed atomically at the end. ` +
      `Do NOT try to read a file you just staged — plan all writes first, then use action:final.\n`
    : `\nNo workspace root set — writes execute immediately via MCP.\n`;

  return {
    role: "system",
    content:
      `You are a precise tool planner (step ${step}/${maxSteps}).${batchNote}\n` +
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
  const workspaceRoot = await getWorkspaceRoot();
  const batchMode = workspaceRoot != null;
  const pendingWrites: PendingWrite[] = [];

  // Batching executor — intercepts fs.write_file, stages instead of writing
  const batchingExecutor = async (name: string, args: any): Promise<any> => {
    if (batchMode && name === "fs.write_file") {
      const path    = args?.path    ?? "";
      const content = args?.content ?? "";

      if (!path || typeof content !== "string") {
        return opts.executeTool!(name, args); // let it fail with a clear error
      }

      pendingWrites.push({ path, content });
      appendToolLog({
        id: `tl-stage-${Date.now()}`,
        ts: Date.now(),
        tool: "fs.write_file [staged]",
        args: { path, contentLength: content.length },
        ok: true,
      });
      return {
        content: [{
          type: "text",
          text: `Staged: ${path} (${content.length} chars). Will be written atomically at the end.`,
        }],
      };
    }
    return opts.executeTool!(name, args);
  };

  const catalog = toolCatalog(tools);
  let convo: OllamaMsg[] = [...opts.messages];
  const steps: StepRecord[] = [];
  let consecutiveParseFailures = 0;

  // ── Agentic loop ──────────────────────────────────────────────────────────

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

    const plannerSystem = buildPlannerSystem(catalog, step, maxSteps, batchMode);

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
      planText = await ollamaChat({
        baseUrl: opts.baseUrl,
        model: opts.plannerModel || opts.model,
        messages: [plannerSystem, ...trimmedConvo], // ← use trimmed, not full convo
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

    if (!tools.some((t) => t.name === toolName)) {
      convo.push({ role: "assistant", content: `[tool not found] "${toolName}" does not exist.` });
      continue;
    }

    const result = await runTool({
      toolName,
      args: plan.args ?? {},
      exec: batchingExecutor,
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

    const commitResult = await commitBatch(pendingWrites, opts.onStatus);

    if (commitResult.ok) {
      const { batch_id, applied } = commitResult.result;
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
  }

  // ── Final streaming answer ────────────────────────────────────────────────

  if (opts.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

  if (steps.length > 0) {
    const lines = steps.map((s) => `- ${s.summary}`).join("\n");
    opts.onToken(`**Actions taken:**\n${lines}\n\n---\n\n`);
  }

  const finalSystem: OllamaMsg = {
    role: "system",
    content:
      `You are a helpful assistant. Synthesize the tool results into a clear, human-readable answer.\n` +
      `Be specific — reference actual file names, paths, and data you found.\n` +
      `Do NOT output JSON. Do NOT suggest using tools again — they have already run.\n` +
      `If batch commit succeeded, confirm which files were written and their paths.\n` +
      `If errors occurred, explain what failed and offer concrete alternatives.`,
  };

  // Use trimmed context for final answer too — avoids overloading the model
  // with all the tool results again (the steps summary covers them)
  const finalConvo = trimContext(convo);

  await ollamaStreamChat({
    baseUrl: opts.baseUrl,
    model: opts.model,
    messages: [finalSystem, ...finalConvo],
    signal: opts.signal,
    onToken: opts.onToken,
  });
}