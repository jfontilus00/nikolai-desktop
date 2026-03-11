# Agent Engineering Rules

**Version:** 1.0  
**Last Updated:** March 2026  
**Applies To:** All AI assistants and human engineers working on `src/lib/agentic.ts` and related modules.

---

## 1. Agent Architecture Overview

The agentic system follows a strict sequential pipeline. **Do not reorder or bypass stages.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AGENT EXECUTION PIPELINE                          │
└─────────────────────────────────────────────────────────────────────────────┘

  User Request
       │
       ▼
  ┌─────────────────┐
  │ 1. Context Trim │ ← trimContext() + summarizeDroppedTools()
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │ 2. Planner LLM  │ ← ollamaChat() / chatFn() with retry + backoff
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │ 3. JSON Parse   │ ← parsePlan() with JSON repair
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │ 4. Tool Resolve │ ← resolveToolName() via aliasMap
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │ 5. Allowlist    │ ← isAgentTool() check (ALLOWED_TOOLS)
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │ 6. Arg Normalize│ ← normalizeToolArgs()
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │ 7. Tool Execute │ ← semanticExecutor() → batchingExecutor() → MCP
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │ 8. Result Append│ ← convo.push() + persist state
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │ 9. Next Step    │ ← Loop continues or action:final
  └─────────────────┘
```

**Key Files:**
- `src/lib/agentic.ts` — Main agent loop (1700+ lines)
- `src/lib/mcp.ts` — MCP client and tool caching
- `src-tauri/src/mcp.rs` — MCP protocol layer (Rust)
- `src-tauri/src/workspace.rs` — Workspace filesystem sandbox (Rust)

---

## 2. Safety Rules

### 2.1 Never Bypass Tool Allowlist

**Rule:** Only tools explicitly listed in `ALLOWED_TOOLS` may execute.

**Location:** `src/lib/agentic.ts` lines ~60-95

```typescript
const ALLOWED_TOOLS: string[] = [
  "fs.read_file", "fs.write_file", "fs.list_directory", "fs.search_files",
  "fs.edit_file", "fs.create_directory", "fs.delete_file", "fs.copy_file",
  "fs.move_file", "fs.rename_file", "semantic.find", "memory.add_fact",
  "hub.refresh", "hub.status",
];

function isAgentTool(name: string): boolean {
  return ALLOWED_TOOLS.some((allowed) => allowed === name);
}
```

**Prohibited:**
- ❌ Adding tools to allowlist without security review
- ❌ Modifying `isAgentTool()` to use blocklist instead of allowlist
- ❌ Creating "escape hatches" for experimental tools

**Rationale:** Blocklist approach allows dangerous new MCP tools to execute automatically. Allowlist requires explicit opt-in.

---

### 2.2 Never Bypass Workspace Sandbox

**Rule:** All filesystem operations must verify paths are under workspace root.

**Location:** `src-tauri/src/workspace.rs`

```rust
fn verify_under_root(path: &Path) -> Result<PathBuf, String> {
  let canonical = fs::canonicalize(path)?;  // Resolves symlinks
  let canonical_root = fs::canonicalize(&root_path)?;
  
  if !canonical.starts_with(&canonical_root) {
    return Err("Security: path escapes workspace root".into());
  }
  Ok(canonical)
}
```

**Prohibited:**
- ❌ Using `resolve()` instead of `resolve_secure()` for existing files
- ❌ Using `resolve()` instead of `resolve_secure_for_write()` for new files
- ❌ Removing symlink resolution (`fs::canonicalize()`)
- ❌ Allowing absolute paths outside workspace root

**Rationale:** Prevents symlink-based escapes where `workspace/evil_link -> /etc/passwd`.

---

### 2.3 Never Allow Absolute Paths

**Rule:** Agent must use relative paths only. Absolute paths must be rejected.

**Location:** `src/lib/agentic.ts` lines ~850-870

```typescript
function isAbsPath(p: string): boolean {
  if (/^[a-zA-Z]:\//.test(p)) return true;  // Windows: C:/...
  if (p.startsWith("/")) return true;        // Unix: /...
  if (p.startsWith("//")) return true;       // UNC: //...
  return false;
}
```

**Prohibited:**
- ❌ Accepting absolute paths from LLM without stripping workspace root
- ❌ Writing files outside workspace root
- ❌ Bypassing `resolveBatchPath()` validation

**Rationale:** Absolute paths break workspace portability and enable path traversal attacks.

---

### 2.4 Never Modify Retry Logic Without Approval

**Rule:** LLM retry logic has specific backoff delays. Do not change without justification.

**Location:** `src/lib/agentic.ts` lines ~1130-1165

```typescript
const MAX_LLM_RETRIES = 3;
const backoffDelays = [0, 1000, 3000]; // attempt 1 → immediate, 2 → 1s, 3 → 3s
```

**Prohibited:**
- ❌ Increasing retries beyond 3 without performance analysis
- ❌ Reducing backoff delays (causes rate limiting)
- ❌ Removing abort error passthrough (`if (e?.name === "AbortError") throw e`)

**Rationale:** Retry logic balances reliability vs. latency. Changes affect user experience.

---

## 3. Patch Discipline

### 3.1 Minimal Patches Only

**Rule:** Modify only the code necessary to fix the specific issue.

**Required:**
- ✅ Identify exact function/lines to change
- ✅ Change only those lines
- ✅ Preserve surrounding code style and structure

**Prohibited:**
- ❌ Refactoring unrelated code "while you're at it"
- ❌ Renaming variables for consistency
- ❌ Reformatting code blocks
- ❌ Extracting helper functions without need

**Example — Good Patch:**
```diff
- function saveAgentRunState(state: Partial<AgentRunState>): void {
-   try {
-     localStorage.setItem(AGENT_RUN_STORAGE_KEY, JSON.stringify(state));
-   } catch {}
- }

+ function saveAgentRunState(state: Partial<AgentRunState>): void {
+   try {
+     localStorage.setItem(AGENT_RUN_STORAGE_KEY, JSON.stringify(state));
+   } catch (e) {
+     console.warn("[agentic] persistence failed", e);
+   }
+ }
```

**Example — Bad Patch:**
```diff
- // Old comment
- function saveAgentRunState(...) { ... }

+ // New improved comment with more details
+ // This function saves agent run state to localStorage
+ // It handles errors gracefully to prevent breaking the agent
+ function persistAgentRunStateToStorage(state: Partial<AgentRunState>): void { ... }
```

---

### 3.2 No Large Refactors Without Approval

**Rule:** Do not refactor more than 50 lines in a single change without explicit approval.

**Requires Approval:**
- Splitting functions into multiple files
- Changing data structures (e.g., `convo` array → Map)
- Rewriting the agent loop
- Modifying the tool execution pipeline

**Does Not Require Approval:**
- Fixing bugs in existing functions
- Adding error handling
- Adding logging
- Updating comments

---

### 3.3 Avoid Architectural Drift

**Rule:** Do not introduce new patterns that conflict with existing architecture.

**Existing Patterns:**
- Tool execution uses `semanticExecutor()` → `batchingExecutor()` → `mcpCallTool()`
- State persistence uses `saveAgentRunState()` with localStorage
- JSON parsing uses `parsePlan()` with repair fallback
- Context management uses `trimContext()` with summarization

**Prohibited:**
- ❌ Adding Redux/Zustand for state (use existing persistence)
- ❌ Adding new LLM client library (use existing `ollamaChat()` / `providerStream()`)
- ❌ Adding database for persistence (use localStorage)

---

## 4. Tool Execution Rules

### 4.1 Always Resolve Tool Names via AliasMap

**Rule:** LLMs emit bare tool names. Always resolve via `resolveToolName()`.

**Location:** `src/lib/agentic.ts` lines ~104-155

```typescript
// LLM outputs: {"action": "tool", "name": "read_file"}
// Must resolve to: "fs.read_file"

const resolvedName = resolveToolName(plan.name, tools, aliasMap);
```

**Why:**
- LLMs don't know fully qualified names
- Alias map handles `read_file` → `fs.read_file`
- Suffix matching handles ambiguous cases

**Prohibited:**
- ❌ Skipping `resolveToolName()` and using `plan.name` directly
- ❌ Modifying alias resolution priority without testing

---

### 4.2 Always Normalize Tool Arguments

**Rule:** LLM arguments may have wrong types or missing fields. Always normalize.

**Location:** `src/lib/agentic.ts` lines ~157-222

```typescript
const normalized = normalizeToolArgs(toolName, plan.args);
if (normalized.error) {
  // Report error to agent, don't execute
  continue;
}
const toolArgs = normalized.args;
```

**What Normalization Does:**
- Converts string args to objects if needed
- Maps alternate field names (`file` → `path`)
- Validates required fields
- Provides clear error messages

**Prohibited:**
- ❌ Passing `plan.args` directly to tool executor
- ❌ Skipping error check on normalized result

---

### 4.3 Never Execute Unknown Tools

**Rule:** If tool not found after refresh, report error — do not attempt execution.

**Location:** `src/lib/agentic.ts` lines ~1220-1245

```typescript
if (!isSynthetic && !tools.some((t) => t.name === toolName)) {
  opts.onStatus?.("🔄 Tool not found — refreshing hub…");
  await semanticExecutor("hub.refresh", {});
  // Re-check...
  if (!tools.some((t) => t.name === toolName)) {
    convo.push({
      role: "assistant",
      content: `[tool not found] "${toolName}" does not exist even after hub refresh.`
    });
    continue;  // ← Skip execution
  }
}
```

**Prohibited:**
- ❌ Calling `mcpCallTool()` with unknown tool name
- ❌ Inventing tool implementations for hallucinated tools
- ❌ Skipping hub refresh before reporting error

---

## 5. Persistence Rules

### 5.1 Agent State Saved Per Step

**Rule:** Call `saveAgentRunState()` after each step completes.

**Location:** `src/lib/agentic.ts` lines ~1405-1415

```typescript
// After tool execution completes:
saveAgentRunState({
  step,
  lastTool: toolName,
  lastToolArgs: toolArgs,
  lastToolOk: result.ok,
});
```

**What Gets Persisted:**
- `runId` — Unique identifier for this run
- `step` — Current step number
- `maxSteps` — Total step budget
- `workspaceRoot` — Workspace path
- `lastTool` — Last tool executed
- `lastToolArgs` — Tool arguments
- `lastToolOk` — Did it succeed?
- `timestamp` — When saved
- `status` — "running" | "completed" | "failed"

**Prohibited:**
- ❌ Skipping persistence to "save time"
- ❌ Persisting full conversation (quota issues)
- ❌ Removing step-level persistence

---

### 5.2 Persistence Failure Must Not Break Execution

**Rule:** All persistence operations wrapped in try/catch. Agent continues on failure.

**Location:** `src/lib/agentic.ts` lines ~729-775

```typescript
function saveAgentRunState(state: Partial<AgentRunState>): void {
  try {
    const existingRaw = localStorage.getItem(AGENT_RUN_STORAGE_KEY);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const merged = { ...existing, ...state, timestamp: Date.now() };
    localStorage.setItem(AGENT_RUN_STORAGE_KEY, JSON.stringify(merged));
  } catch (e) {
    console.warn("[agentic] persistence failed: saveAgentRunState", e);
    // Continue execution — persistence is non-critical
  }
}
```

**Failure Modes Handled:**
- Private browsing mode
- Quota exceeded (5MB limit)
- Storage disabled by user/browser
- Security restrictions (CSP, sandboxed iframes)

**Prohibited:**
- ❌ Throwing errors from persistence functions
- ❌ Aborting agent run on persistence failure
- ❌ Silent failures (must log warning)

---

## 6. LLM Parsing Rules

### 6.1 JSON Parse First (Fast Path)

**Rule:** Always try standard `JSON.parse()` before repair.

**Location:** `src/lib/agentic.ts` lines ~551-587

```typescript
function parsePlan(raw: string): Plan | null {
  const jsonCandidate = cleaned.slice(start, end + 1);

  // Attempt 1: Standard JSON parse (fast path)
  try {
    const obj = JSON.parse(jsonCandidate);
    if (obj?.action === "tool" && typeof obj?.name === "string") {
      return { action: "tool", name: obj.name, args: obj.args ?? {} };
    }
  } catch {
    // Parse failed — try repair
  }

  // Attempt 2: Repaired JSON
  // ...
}
```

**Why:**
- 95%+ of LLM outputs are valid JSON
- Standard parse is fastest
- Repair only runs on failure

**Prohibited:**
- ❌ Always running repair (unnecessary overhead)
- ❌ Skipping standard parse

---

### 6.2 JSON Repair for Common Issues

**Rule:** Attempt lightweight repair for malformed JSON.

**Location:** `src/lib/agentic.ts` lines ~517-549

```typescript
function repairJsonString(jsonStr: string): string {
  let repaired = jsonStr;

  // Step 1: Remove trailing commas
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // Step 2: Quote unquoted keys
  repaired = repaired.replace(
    /([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g,
    '$1"$2":'
  );

  // Step 3: Convert single quotes to double quotes
  repaired = repaired.replace(/'([^']*)'\s*:/g, '"$1":');

  // ... more repairs

  return repaired;
}
```

**What Gets Repaired:**
- ✅ Unquoted keys: `{ tool: "x" }` → `{ "tool": "x" }`
- ✅ Trailing commas: `{ "a": 1, }` → `{ "a": 1 }`
- ✅ Single quotes: `{ 'a': 1 }` → `{ "a": 1 }`
- ✅ Markdown artifacts: ` ```json {...} ` → `{...}`

**What Does NOT Get Repaired (intentional):**
- ❌ Missing braces: ` "a": 1 ` → still fails
- ❌ Unquoted values: `{ "a": tool }` → still fails
- ❌ Structural errors: `{ "a": 1 "b": 2 }` → still fails

**Rationale:** Lightweight repair handles 80% of common errors without complex parsing.

---

### 6.3 Fallback Behavior Preserved

**Rule:** If parse and repair both fail, return `null` (existing error behavior).

**Location:** `src/lib/agentic.ts` lines ~580-587

```typescript
function parsePlan(raw: string): Plan | null {
  // ... attempt 1: standard parse
  // ... attempt 2: repaired parse
  
  // Both failed — return null (triggers existing retry/error logic)
  return null;
}
```

**What Happens on `null` Return:**
1. `consecutiveParseFailures` incremented
2. After `MAX_PLAN_PARSE_RETRIES` (2), agent gives up
3. Error message shown to user
4. Agent loop breaks or continues with error

**Prohibited:**
- ❌ Throwing errors from `parsePlan()`
- ❌ Returning fake/placeholder plans
- ❌ Infinite retry loops

---

## Appendix A: Quick Reference

### Key Constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `MAX_STEPS` | 10 (default) | `agenticStreamChat()` | Max agent steps per run |
| `KEEP_LAST_TOOL_RESULTS` | 4 | Line ~58 | Context window management |
| `MAX_CONTEXT_CHARS` | 10,000 | Line ~57 | Context window char limit |
| `MAX_LLM_RETRIES` | 3 | Line ~1130 | LLM retry attempts |
| `MAX_PLAN_PARSE_RETRIES` | 2 | Line ~670 | JSON parse retry attempts |
| `CIRCUIT_BREAK_THRESHOLD` | 2 | Line ~1055 | Tool failure threshold |

### Key Functions

| Function | Purpose | Lines |
|----------|---------|-------|
| `agenticStreamChat()` | Main agent loop | 700-1600 |
| `trimContext()` | Context window management | 402-444 |
| `summarizeDroppedTools()` | Context summarization | 446-526 |
| `parsePlan()` | JSON parsing + repair | 551-587 |
| `resolveToolName()` | Tool name resolution | 104-155 |
| `normalizeToolArgs()` | Argument normalization | 157-222 |
| `isAgentTool()` | Allowlist check | 93-95 |
| `saveAgentRunState()` | Persistence | 729-738 |

### Error Handling Patterns

```typescript
// Pattern 1: Non-critical operation (fail silently with log)
try {
  localStorage.setItem(KEY, JSON.stringify(state));
} catch (e) {
  console.warn("[agentic] persistence failed", e);
}

// Pattern 2: Critical operation (fail with error)
if (!opts.executeTool) {
  opts.onToken(`\n\n[agent] No tool executor provided.\n`);
  clearAgentRunState();
  return;
}

// Pattern 3: Retry with backoff
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    return await operation();
  } catch (e) {
    if (attempt === MAX_RETRIES) throw e;
    await sleep(backoffDelays[attempt - 1]);
  }
}
```

---

## Appendix B: Security Checklist

Before merging any change to `agentic.ts`:

- [ ] Tool allowlist unchanged (or security-reviewed)
- [ ] Workspace sandbox intact (no path escape possible)
- [ ] Absolute paths still rejected
- [ ] Persistence errors don't break execution
- [ ] JSON repair doesn't introduce injection vectors
- [ ] Retry logic preserves abort handling
- [ ] Context summarization doesn't leak sensitive data

---

## Appendix C: Testing Guidelines

### Unit Tests Required For:

- `parsePlan()` — Valid JSON, malformed JSON, repair cases
- `trimContext()` — Context trimming, summary generation
- `summarizeDroppedTools()` — Summary format, edge cases
- `resolveToolName()` — Alias resolution, ambiguous names
- `normalizeToolArgs()` — Argument validation, error messages

### Integration Tests Required For:

- Full agent loop (10 steps)
- Tool execution pipeline
- Persistence recovery
- LLM retry behavior
- Context overflow handling

### Manual Testing Required For:

- Symlink escape attempts
- Absolute path rejection
- Private browsing mode
- Quota exceeded scenarios
- Network failure during LLM calls

---

**END OF DOCUMENT**
