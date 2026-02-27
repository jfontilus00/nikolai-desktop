# Nikolai Desktop -- DEEP CODE INSPECTION
# This script reads your actual source files and reports
# what is solid, what is weak, and what should be improved.
# Run from project root: .\inspect.ps1
# ============================================================

$ErrorActionPreference = "SilentlyContinue"
$script:solid  = 0
$script:weak   = 0
$script:risk   = 0
$script:log    = @()
$script:findings = @()

function SOLID ($area, $msg) {
    Write-Host "  [SOLID] $area -- $msg" -ForegroundColor Green
    $script:solid++
    $script:log += "[SOLID] $area -- $msg"
    $script:findings += [PSCustomObject]@{ Level="SOLID"; Area=$area; Message=$msg }
}
function WEAK ($area, $msg) {
    Write-Host "  [WEAK]  $area -- $msg" -ForegroundColor Yellow
    $script:weak++
    $script:log += "[WEAK]  $area -- $msg"
    $script:findings += [PSCustomObject]@{ Level="WEAK"; Area=$area; Message=$msg }
}
function RISK ($area, $msg) {
    Write-Host "  [RISK]  $area -- $msg" -ForegroundColor Red
    $script:risk++
    $script:log += "[RISK]  $area -- $msg"
    $script:findings += [PSCustomObject]@{ Level="RISK"; Area=$area; Message=$msg }
}
function HEAD ($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
    $script:log += "`n==> $msg"
}
function INFO ($msg) {
    Write-Host "       $msg" -ForegroundColor DarkGray
    $script:log += "       $msg"
}

# Helper: read file safely
function ReadFile ($path) {
    if (Test-Path $path) { return Get-Content $path -Raw -ErrorAction SilentlyContinue }
    return ""
}

# Helper: count pattern occurrences
function CountMatches ($content, $pattern) {
    return ([regex]::Matches($content, $pattern)).Count
}

# ============================================================
HEAD "A. MCP LAYER (mcp.rs + mcp.ts)"

$mcpRs = ReadFile "src-tauri\src\mcp.rs"
$mcpTs = ReadFile "src\lib\mcp.ts"

# Rust: deadlock fix
if ($mcpRs -match "guard.*dropped" -or $mcpRs -match "// .* guard") {
    SOLID "mcp.rs" "Mutex guard scoping comments present -- deadlock fix is documented"
} else {
    WEAK "mcp.rs" "No guard scoping comments found -- hard to verify deadlock fix is correct"
}

# Rust: reader_loop uses global state
if ($mcpRs -match "ensure_state\(\)" -and $mcpRs -match "reader_loop") {
    SOLID "mcp.rs" "reader_loop receives ensure_state() -- unexpected disconnects update UI correctly"
} else {
    RISK "mcp.rs" "reader_loop may not use global state -- disconnects may be silent"
}

# Rust: fail_all_pending on EOF
if ($mcpRs -match "fail_all_pending" -and $mcpRs -match "EOF") {
    SOLID "mcp.rs" "fail_all_pending called on EOF -- in-flight tool calls fail fast instead of hanging 60s"
} else {
    WEAK "mcp.rs" "fail_all_pending may not be called on process exit -- tool calls could hang"
}

# Rust: timeout values
if ($mcpRs -match "MCP_TIMEOUT_SECS.*60" -or $mcpRs -match "60.*MCP_TIMEOUT") {
    WEAK "mcp.rs" "Tool timeout is 60s -- this is high. Consider 30s for better UX on hung tools"
} else {
    SOLID "mcp.rs" "Timeout value configured (verify it is 30-45s range)"
}

# Rust: buffer overflow protection
if ($mcpRs -match "MAX_BUFFER_SIZE") {
    SOLID "mcp.rs" "MAX_BUFFER_SIZE guard present -- large MCP responses won't crash the reader"
} else {
    RISK "mcp.rs" "No buffer size limit found -- a large MCP response could exhaust memory"
}

# Rust: single server only
$mcpConnectCount = CountMatches $mcpRs "fn mcp_connect"
if ($mcpConnectCount -eq 1) {
    WEAK "mcp.rs" "Single MCP server only -- can only connect to one server at a time (mcp-hub handles this for now)"
}

# TS: auto-reconnect
if ($mcpTs -match "scheduleAutoReconnect" -and $mcpTs -match "exponential") {
    SOLID "mcp.ts" "Auto-reconnect with exponential backoff implemented"
} elseif ($mcpTs -match "scheduleAutoReconnect") {
    SOLID "mcp.ts" "Auto-reconnect implemented"
} else {
    RISK "mcp.ts" "No auto-reconnect found -- if mcp-hub crashes, user must reconnect manually"
}

# TS: getCachedTools
if ($mcpTs -match "getCachedTools") {
    SOLID "mcp.ts" "getCachedTools() present -- /tools command reads cache, no round-trip"
} else {
    WEAK "mcp.ts" "getCachedTools() missing -- /tools causes unnecessary MCP round-trip"
}

# TS: store pattern
if ($mcpTs -match "useSyncExternalStore") {
    SOLID "mcp.ts" "useSyncExternalStore pattern -- MCP state updates are React-safe and concurrent-mode compatible"
} else {
    WEAK "mcp.ts" "Not using useSyncExternalStore -- state updates may cause tearing in React 18"
}

# ============================================================
HEAD "B. AGENTIC LOOP (agentic.ts)"

$ag = ReadFile "src\lib\agentic.ts"

# getCachedTools instead of mcpListTools on every call
if ($ag -match "getCachedTools" -and $ag -match "fallback\|length.*0\|0.*length") {
    SOLID "agentic.ts" "getCachedTools with fallback -- no MCP round-trip on every agentic request"
} elseif ($ag -match "await mcpListTools\(\)" -and -not ($ag -match "getCachedTools")) {
    WEAK "agentic.ts" "mcpListTools() called on every agentic request -- 1-3s delay before planning starts"
}

# maxSteps
if ($ag -match "maxSteps.*10" -or $ag -match "10.*maxSteps") {
    SOLID "agentic.ts" "maxSteps=10 -- sufficient for most multi-file tasks"
} elseif ($ag -match "maxSteps.*3") {
    RISK "agentic.ts" "maxSteps=3 -- way too low, breaks on any task needing 4+ steps"
} else {
    WEAK "agentic.ts" "maxSteps value unclear -- verify it is 8-12"
}

# Context trimming
if ($ag -match "trimContext") {
    SOLID "agentic.ts" "trimContext() implemented -- context window protected on long tasks"
    # Check the constants
    if ($ag -match "MAX_CONTEXT_CHARS.*10.000" -or $ag -match "10_000") {
        SOLID "agentic.ts" "MAX_CONTEXT_CHARS=10000 -- reasonable cap for 8B models"
    } else {
        WEAK "agentic.ts" "MAX_CONTEXT_CHARS value not confirmed -- check it is 8000-12000"
    }
    if ($ag -match "KEEP_LAST_TOOL_RESULTS.*4" -or $ag -match "4.*KEEP_LAST") {
        SOLID "agentic.ts" "Keeps last 4 tool results -- good balance of memory vs context"
    }
} else {
    RISK "agentic.ts" "No context trimming -- long tasks will overflow model context window silently"
}

# Batch writes
if ($ag -match "ws_batch_apply") {
    SOLID "agentic.ts" "Atomic batch writes via ws_batch_apply -- no more partial file creation"
    if ($ag -match "rollbackBatch") {
        SOLID "agentic.ts" "Auto-rollback on batch failure -- filesystem restored to pre-agent state"
    } else {
        RISK "agentic.ts" "Batch apply present but no rollback -- failure leaves partial state"
    }
} else {
    RISK "agentic.ts" "No batch writes -- multi-file agent tasks can leave partial state on failure"
}

# Plan parse retry
if ($ag -match "MAX_PLAN_PARSE_RETRIES") {
    SOLID "agentic.ts" "Plan parse retry logic present -- model JSON failures get a second chance"
} else {
    WEAK "agentic.ts" "No parse retry -- one bad JSON response from model kills the whole task"
}

# Error recovery (tool errors fed back)
if ($ag -match "Choose a different approach") {
    SOLID "agentic.ts" "Tool errors fed back into conversation -- model can adapt and try alternatives"
} else {
    WEAK "agentic.ts" "Tool errors may stop chain silently -- model does not get chance to recover"
}

# Blocklist vs allowlist
if ($ag -match "BLOCKED_TOOL_PATTERNS") {
    SOLID "agentic.ts" "Blocklist approach -- new tools available automatically, only dangerous ones blocked"
} elseif ($ag -match "isAllowedAgenticTool\|ALLOWED_TOOLS") {
    WEAK "agentic.ts" "Allowlist approach -- new tools blocked by default, must be manually added"
}

# Result truncation
if ($ag -match "MAX_RESULT_CHARS") {
    SOLID "agentic.ts" "Tool result truncation present -- large file reads won't overflow context"
    if ($ag -match "6000" -or $ag -match "6_000") {
        SOLID "agentic.ts" "MAX_RESULT_CHARS=6000 -- good cap per tool result"
    }
} else {
    RISK "agentic.ts" "No result truncation -- reading a large file injects all content into context"
}

# Human status messages
if ($ag -match "humanStatus") {
    SOLID "agentic.ts" "humanStatus() -- spinner shows readable text not raw tool names"
} else {
    WEAK "agentic.ts" "No humanStatus() -- spinner shows cryptic tool names to the user"
}

# Actions summary
if ($ag -match "Actions taken") {
    SOLID "agentic.ts" "Actions summary emitted before final answer -- user sees what was done"
} else {
    WEAK "agentic.ts" "No actions summary -- user gets answer but cannot see what tools ran"
}

# Final streaming answer separate from planner
if ($ag -match "ollamaStreamChat" -and $ag -match "finalSystem") {
    SOLID "agentic.ts" "Final answer uses streaming + separate system prompt -- responsive and focused"
} else {
    WEAK "agentic.ts" "Final answer path unclear -- may be blocking or use planner prompt"
}

# ============================================================
HEAD "C. TOOL COMMAND PARSER (toolCmd.ts)"

$tc = ReadFile "src\lib\toolCmd.ts"

# TS: discriminated union return type (delivered version)
if ($tc -match "ok.*true" -and $tc -match "ok.*false" -and $tc -match "ToolCommand") {
    SOLID "toolCmd.ts" "Discriminated union return type -- parse errors are typed, never reach mcpCallTool"
} elseif ($tc -match "__parse_error__") {
    RISK "toolCmd.ts" "Old __parse_error__ sentinel still present -- bad args reach mcpCallTool -- deploy latest toolCmd.ts"
} else {
    WEAK "toolCmd.ts" "Return type unclear -- verify parse errors are caught before tool execution"
}

if ($tc -match "Windows path\|forward slash\|backslash") {
    SOLID "toolCmd.ts" "Windows path tip in error messages -- users get actionable guidance"
} else {
    WEAK "toolCmd.ts" "No Windows path guidance in errors -- C:\path errors will confuse users"
}

# ============================================================
HEAD "D. TOOL RESULT FORMATTER (toolResult.ts)"

$tr = ReadFile "src\lib\toolResult.ts"

if ($tr -match "READ_FILE_PREVIEW_LINES") {
    SOLID "toolResult.ts" "Large file preview truncation -- read_file won't dump 1000 lines into chat"
    if ($tr -match "200") {
        SOLID "toolResult.ts" "READ_FILE_PREVIEW_LINES=200 -- reasonable preview size"
    }
} else {
    WEAK "toolResult.ts" "No line preview limit for file reads -- large files will flood the chat"
}

if ($tr -match "isError") {
    SOLID "toolResult.ts" "isError flag on FormattedToolResult -- errors are distinguished from content"
} else {
    WEAK "toolResult.ts" "No isError distinction -- tool errors look like normal content in chat"
}

if ($tr -match "formatDirectoryListing") {
    SOLID "toolResult.ts" "Directory listing formatter -- fs.list_directory shows clean file tree"
} else {
    WEAK "toolResult.ts" "No directory listing formatter -- raw JSON arrays shown to user"
}

if ($tr -match "MAX.*80000\|80_000") {
    SOLID "toolResult.ts" "80KB hard cap on tool result display -- browser won't freeze on huge outputs"
} else {
    WEAK "toolResult.ts" "No hard cap on result size -- very large results could freeze the UI"
}

# ============================================================
HEAD "E. TOOL LOG (toolLog.ts)"

$tl = ReadFile "src\lib\toolLog.ts"

if ($tl -match "MAX_ITEMS.*120\|120.*MAX_ITEMS") {
    SOLID "toolLog.ts" "MAX_ITEMS=120 -- log won't grow unbounded"
} else {
    WEAK "toolLog.ts" "No MAX_ITEMS limit -- tool log grows forever in localStorage"
}

if ($tl -match "MAX_TOTAL_CHARS\|200.000\|200_000") {
    SOLID "toolLog.ts" "Total size cap on localStorage -- quota errors prevented"
} else {
    WEAK "toolLog.ts" "No total size cap -- tool log will eventually hit localStorage quota"
}

if ($tl -match "persistSafe\|QuotaExceeded\|quota") {
    SOLID "toolLog.ts" "Quota exceeded handling -- graceful degradation when storage is full"
} else {
    RISK "toolLog.ts" "No quota exceeded handling -- localStorage full will silently drop all logs -- deploy latest toolLog.ts"
}

# ============================================================
HEAD "F. APP.TSX -- CHAT ORCHESTRATION"

$app = ReadFile "src\App.tsx"

# Tool timeout
if ($app -match "TOOL_TIMEOUT_MS.*20000\|20000.*TOOL_TIMEOUT") {
    SOLID "App.tsx" "TOOL_TIMEOUT_MS=20000 -- 20s ceiling, won't leave user waiting 45s on hung tool"
} elseif ($app -match "TOOL_TIMEOUT_MS.*45000\|45000.*TOOL_TIMEOUT") {
    WEAK "App.tsx" "TOOL_TIMEOUT_MS=45000 -- too high, reduce to 20000"
} else {
    WEAK "App.tsx" "TOOL_TIMEOUT_MS value unclear -- verify it is 20000-30000"
}

# Double-fire guard
if ($app -match "sendingRef") {
    SOLID "App.tsx" "sendingRef guard present -- double-click / rapid Enter cannot fire two requests"
} else {
    WEAK "App.tsx" "No sendingRef guard -- double-click can fire two concurrent requests"
}

# Auto-title
if ($app -match "autoTitleChat\|New chat.*title\|title.*New chat") {
    SOLID "App.tsx" "autoTitleChat present -- chats get meaningful titles from first message"
} else {
    WEAK "App.tsx" "No auto-title -- all chats remain 'New chat', unusable after a week of daily use"
}

# sessionStorage for tool approvals
if ($app -match "sessionStorage.*tool.allow\|nikolai.tool.allow") {
    SOLID "App.tsx" "toolAllowInChat persisted to sessionStorage -- approvals survive hot-reload"
} else {
    WEAK "App.tsx" "toolAllowInChat is plain state -- all approvals lost on every reload"
}

# No loadChats() in send hot path
if ($app -match "updatedChats.find\|currentChat.*updatedChats") {
    SOLID "App.tsx" "send() uses in-memory state -- no disk read on every message"
} elseif ($app -match "loadChats\(\).*find") {
    WEAK "App.tsx" "send() calls loadChats() on every message -- unnecessary localStorage read"
}

# FIX: Added missing if statement here
if ($app -match "agentStatus.*React.*state\|setAgentStatus") {
    SOLID "App.tsx" "agentStatus is React state -- status never written to message content or disk"
} else {
    RISK "App.tsx" "__STATUS__: sentinel may still be used -- crashed agent leaves broken messages"
}

# finally block clears status
$finallyBlocks = CountMatches $app "finally"
$clearInFinally = CountMatches $app 'setAgentStatus\("")'
if ($clearInFinally -ge 2) {
    SOLID "App.tsx" "setAgentStatus cleared in finally blocks ($clearInFinally times) -- status always clears on stop/error"
} else {
    WEAK "App.tsx" "setAgentStatus may not clear in all error paths -- status indicator could get stuck"
}

# getCachedTools for /tools
if ($app -match "getCachedTools") {
    SOLID "App.tsx" "/tools command uses getCachedTools -- instant response, no MCP round-trip"
} else {
    WEAK "App.tsx" "/tools still calls mcpListTools -- unnecessary round-trip every time"
}

# shouldUseAgentic heuristic quality
if ($app -match "actionVerbs.*fileNouns\|fileNouns.*actionVerbs") {
    SOLID "App.tsx" "shouldUseAgentic requires verb+noun -- 'what is a file?' stays in plain chat"
} elseif ($app -match "shouldUseAgentic.*file") {
    WEAK "App.tsx" "shouldUseAgentic may trigger on keyword 'file' alone -- innocent questions route to agent"
}

# rAF streaming buffer
if ($app -match "requestAnimationFrame\|rAF\|scheduleFlush") {
    SOLID "App.tsx" "rAF-buffered streaming -- tokens batch-rendered, no per-character React re-renders"
} else {
    WEAK "App.tsx" "No streaming buffer -- every token causes a React re-render, UI may stutter"
}

# Abort controller
if ($app -match "AbortController" -and $app -match "abortRef") {
    SOLID "App.tsx" "AbortController + ref -- Stop button actually cancels in-flight requests"
} else {
    RISK "App.tsx" "No AbortController found -- Stop button may not cancel streaming"
}

# legacy __STATUS__ cleanup
if ($app -match "__STATUS__" -and $app -match "clearStatusForActiveChat") {
    SOLID "App.tsx" "Legacy __STATUS__: cleanup function present -- old saved chats can be cleaned"
} else {
    WEAK "App.tsx" "No legacy status cleanup -- old chats may show broken __STATUS__: messages"
}

# Memory cleanup on unmount
if ($app -match "cancelAnimationFrame" -and $app -match "useEffect.*return") {
    SOLID "App.tsx" "rAF cleanup on unmount -- no animation frame leaks"
} else {
    WEAK "App.tsx" "No rAF cleanup on unmount -- animation frames may leak if component unmounts"
}

# Tool approval per-chat allow
if ($app -match "toolAllowInChat") {
    SOLID "App.tsx" "Per-chat tool allow list -- approval persists for session without re-prompting"
} else {
    WEAK "App.tsx" "No per-chat allow -- user must approve every single tool call"
}

# ============================================================
HEAD "G. CHAT CENTER (ChatCenter.tsx)"

$cc = ReadFile "src\components\ChatCenter.tsx"

# Agent status prop (not sentinel)
if ($cc -match "agentStatus.*Props\|Props.*agentStatus\|agentStatus\?.*string\|agentStatus =") {
    SOLID "ChatCenter.tsx" "agentStatus is a prop -- floating indicator, never a message in the thread"
} else {
    RISK "ChatCenter.tsx" "agentStatus prop missing -- may still render __STATUS__: from message content -- deploy latest ChatCenter.tsx"
}

# Tool action cards
if ($cc -match "ToolActionsBlock" -and $cc -match "ToolStepCard") {
    SOLID "ChatCenter.tsx" "Tool action cards -- agent steps shown as visual cards not raw markdown"
} else {
    WEAK "ChatCenter.tsx" "No tool cards -- agent action summary dumped as plain text into message"
}

# parseAgentMessage
if ($cc -match "parseAgentMessage") {
    SOLID "ChatCenter.tsx" "parseAgentMessage() -- Actions taken block parsed out from message content"
} else {
    WEAK "ChatCenter.tsx" "No parseAgentMessage -- full raw content including action markers shown to user"
}

# Legacy status support
if ($cc -match "isLegacyStatus\|__STATUS__") {
    SOLID "ChatCenter.tsx" "Legacy __STATUS__: messages handled -- old chats render as spinner not broken text"
} else {
    WEAK "ChatCenter.tsx" "No legacy status handling -- old chats with __STATUS__: show raw text"
}

# Identity guard
if ($cc -match "guardIdentityDisplay\|i am kimi\|i am claude") {
    SOLID "ChatCenter.tsx" "Identity guard present -- model won't claim to be Kimi/Claude/ChatGPT"
} else {
    WEAK "ChatCenter.tsx" "No identity guard -- local model may respond as Kimi or other AI"
}

# MCP reconnect in header
if ($cc -match "reconnectMcp\|mcpDegraded") {
    SOLID "ChatCenter.tsx" "MCP reconnect button in chat header -- user can recover without going to Settings"
} else {
    WEAK "ChatCenter.tsx" "No reconnect button in chat -- user must navigate to Settings tab to reconnect"
}

# Auto-scroll
if ($cc -match "scrollIntoView") {
    SOLID "ChatCenter.tsx" "Auto-scroll on new messages -- chat follows latest content"
} else {
    WEAK "ChatCenter.tsx" "No auto-scroll -- new messages appear off-screen"
}

# Export
if ($cc -match "downloadMarkdown\|Export") {
    SOLID "ChatCenter.tsx" "Markdown export button -- chat history can be saved"
} else {
    WEAK "ChatCenter.tsx" "No export -- chat history cannot be saved from the UI"
}

# ============================================================
HEAD "H. TOOL APPROVAL MODAL (ToolApprovalModal.tsx)"

$ta = ReadFile "src\components\ToolApprovalModal.tsx"

if ($ta -match "serverFromTool\|bareToolName") {
    SOLID "ToolApprovalModal.tsx" "Server label derived from tool name -- modal shows context not just raw name"
} else {
    WEAK "ToolApprovalModal.tsx" "No server label -- modal shows raw tool name without context"
}

if ($ta -match "argsExpanded\|setArgsExpanded") {
    SOLID "ToolApprovalModal.tsx" "Collapsible args panel -- args don't dominate the modal"
} else {
    WEAK "ToolApprovalModal.tsx" "No collapsible args -- large arg objects take over the modal"
}

if ($ta -match "onDeny.*onAllowOnce.*onAllowChat\|Deny.*Allow once.*Allow in this chat") {
    SOLID "ToolApprovalModal.tsx" "Three-option approval -- Deny / Once / Chat gives proper granularity"
} else {
    WEAK "ToolApprovalModal.tsx" "Missing approval options -- user has insufficient control"
}

# ============================================================
HEAD "I. WORKSPACE (workspace.rs)"

$ws = ReadFile "src-tauri\src\workspace.rs"

if ($ws -match "ws_batch_apply" -and $ws -match "ws_batch_rollback") {
    SOLID "workspace.rs" "Batch apply + rollback both present -- atomic multi-file operations supported"
} else {
    RISK "workspace.rs" "Batch apply or rollback missing -- multi-file operations are not atomic"
}

if ($ws -match "sanitize_rel\|ParentDir.*not allowed\|\.\. not allowed") {
    SOLID "workspace.rs" "Path traversal protection -- '..' in paths is blocked"
} else {
    RISK "workspace.rs" "No path traversal check -- agent could write outside workspace root"
}

if ($ws -match "manifest\.jsonl\|write_manifest") {
    SOLID "workspace.rs" "Audit manifest (manifest.jsonl) -- every write is logged for recovery"
} else {
    WEAK "workspace.rs" "No audit manifest -- no record of what was written for recovery"
}

if ($ws -match "max.*200\|200.*max\|too many files") {
    SOLID "workspace.rs" "Batch file limit (200) -- agent cannot write unbounded files in one call"
} else {
    WEAK "workspace.rs" "No batch size limit -- agent could theoretically write thousands of files"
}

if ($ws -match "\.nikolai_backups") {
    SOLID "workspace.rs" "Backups stored in .nikolai_backups -- originals preserved before any overwrite"
} else {
    WEAK "workspace.rs" "No backup directory pattern found -- overwrites may not be recoverable"
}

# ============================================================
HEAD "J. TAURI VERSION AND BUILD"

$cargoToml = ReadFile "src-tauri\Cargo.toml"

# Tauri version
if ($cargoToml -match "tauri.*=.*1\." -or $cargoToml -match '"1\.') {
    WEAK "Cargo.toml" "Using Tauri v1 -- Tauri v2 is stable and has better security model. Not urgent for v1 but worth planning"
}

# Icons
if (Test-Path "src-tauri\icons") {
    $iconCount = (Get-ChildItem "src-tauri\icons" -ErrorAction SilentlyContinue).Count
    if ($iconCount -ge 5) { SOLID "icons" "$iconCount icon files present -- all platform sizes covered" }
    else { WEAK "icons" "Only $iconCount icon files -- some platform sizes may be missing" }
} else {
    WEAK "icons" "No icons folder -- app will use default Tauri icon"
}

# dist has content
if (Test-Path "dist") {
    $distFiles = (Get-ChildItem "dist" -Recurse -ErrorAction SilentlyContinue).Count
    if ($distFiles -lt 3) {
        WEAK "dist" "dist has only $distFiles files -- may be stale. Run pnpm build before tauri build"
    } else {
        SOLID "dist" "dist has $distFiles files -- frontend build looks complete"
    }
}

# node_modules count (pnpm uses virtual store)
if (Test-Path "node_modules") {
    $nmDirs = (Get-ChildItem "node_modules" -Directory -ErrorAction SilentlyContinue).Count
    if ($nmDirs -lt 50 -and (Test-Path "node_modules\.pnpm")) {
        SOLID "node_modules" "pnpm virtual store detected ($nmDirs top-level dirs) -- this is normal for pnpm"
    } elseif ($nmDirs -lt 10) {
        WEAK "node_modules" "Only $nmDirs dirs in node_modules -- may be incomplete, run: pnpm install"
    }
}

# ============================================================
HEAD "K. WHAT IS MISSING vs CLAUDE DESKTOP"

INFO "The following are gaps vs Claude Desktop or known improvement areas."
INFO "These are not bugs -- they are the next feature layer."
INFO ""

WEAK "multi-server MCP" "Only 1 MCP server at a time. Claude Desktop supports 10+. Needs mcp.rs rewrite with server map."
WEAK "tool streaming" "Tool results block until complete. Claude Desktop shows progressive output. Needs Tauri event channel."
WEAK "Tauri v1" "Using Tauri 1.5.9. v2 has better IPC security, permissions model, and mobile support."
WEAK "no prompt caching" "Planner system prompt + tool catalog rebuilt on every step. Could cache hash and skip rebuild."
WEAK "no conversation search" "No way to search across all chats. Growing chat list becomes hard to navigate."
WEAK "single provider at once" "Only one AI provider active at a time. No fallback if primary is unavailable."
WEAK "no model benchmarking" "No way to test which local model performs best at planning for your tasks."

# ============================================================
HEAD "L. SUMMARY AND VERDICT"

$total = $script:solid + $script:weak + $script:risk
Write-Host ""
Write-Host "  SOLID (production-ready) : $($script:solid) / $total" -ForegroundColor Green
Write-Host "  WEAK  (improvable)       : $($script:weak) / $total" -ForegroundColor Yellow
Write-Host "  RISK  (should fix)       : $($script:risk) / $total" -ForegroundColor Red
Write-Host ""

Write-Host "  RISK ITEMS (fix before daily use):" -ForegroundColor Red
$script:findings | Where-Object { $_.Level -eq "RISK" } | ForEach-Object {
    Write-Host "    - $($_.Area): $($_.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "  TOP 5 WEAK ITEMS TO IMPROVE NEXT:" -ForegroundColor Yellow
$script:findings | Where-Object { $_.Level -eq "WEAK" -and $_.Area -notmatch "Claude Desktop|multi-server|streaming|Tauri v1|caching|search|provider|benchmark" } | Select-Object -First 5 | ForEach-Object {
    Write-Host "    - $($_.Area): $($_.Message)" -ForegroundColor Yellow
}

Write-Host ""
if ($script:risk -eq 0) {
    Write-Host "  VERDICT: No critical risks found. Safe for daily use as v1." -ForegroundColor Green
    Write-Host "  Build:   npm run tauri build" -ForegroundColor Cyan
} elseif ($script:risk -le 2) {
    Write-Host "  VERDICT: $($script:risk) risk item(s) found. Review before building." -ForegroundColor Yellow
} else {
    Write-Host "  VERDICT: $($script:risk) risk items. Address before daily use." -ForegroundColor Red
}

# Save full report
$logFile = "nikolai-inspect-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log"
$script:log | Out-File $logFile -Encoding UTF8
Write-Host ""
Write-Host "  Full report saved: $logFile" -ForegroundColor DarkGray
Write-Host ""