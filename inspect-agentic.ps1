# ====================================================================
# Atelier NikolAi — Deep Agentic Pipeline Inspector v1
# Traces every step: user msg → shouldUseAgentic → agenticStreamChat
#                    → batchingExecutor → commitBatch → verify
#
# Run from project root:  .\inspect-agentic.ps1
# Output: inspect-agentic-<timestamp>.log  +  console
# ====================================================================

$ErrorActionPreference = "SilentlyContinue"
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = "inspect-agentic-$ts.log"
$lines = @()

function W($color, $msg) {
    Write-Host $msg -ForegroundColor $color
    $script:lines += $msg
}
function HEAD($msg)  { W Cyan    "`n══════════════════════════════════════════`n  $msg`n══════════════════════════════════════════" }
function OK($msg)   { W Green   "  [OK]     $msg" }
function WARN($msg) { W Yellow  "  [WARN]   $msg" }
function FAIL($msg) { W Red     "  [FAIL]   $msg" }
function INFO($msg) { W DarkGray "  [info]   $msg" }
function NOTE($msg) { W White   "  [note]   $msg" }

function Src($path) {
    if (Test-Path $path) { return Get-Content $path -Raw -EA SilentlyContinue }
    return ""
}
function Has($src, $pat) { return [bool]($src -match $pat) }
function Count($src, $pat) { return ([regex]::Matches($src, $pat)).Count }

W White ""
W White "  NikolAi Deep Agentic Inspector — $ts"
W White ""

# ── Load all relevant source files ───────────────────────────────────────────
HEAD "0. SOURCE FILES"

$agFile   = "src\lib\agentic.ts"
$appFile  = "src\App.tsx"
$wsRs     = "src-tauri\src\workspace.rs"
$mcpTs    = "src\lib\mcp.ts"
$olChat   = "src\lib\ollamaChat.ts"
$olStream = "src\lib\ollamaStream.ts"
$toolRes  = "src\lib\toolResult.ts"

$ag  = Src $agFile
$app = Src $appFile
$ws  = Src $wsRs
$mcp = Src $mcpTs

foreach ($f in @($agFile,$appFile,$wsRs,$mcpTs,$olChat,$olStream,$toolRes)) {
    if (Test-Path $f) {
        $sz = (Get-Item $f).Length
        OK "$f  ($sz bytes)"
    } else {
        FAIL "MISSING: $f"
    }
}

# ── SECTION 1: shouldUseAgentic gate ─────────────────────────────────────────
HEAD "1. shouldUseAgentic GATE (when does agentic mode trigger?)"

if (Has $app "shouldUseAgentic") {
    # Extract the function body
    $fnMatch = [regex]::Match($app, "function shouldUseAgentic\([^)]*\)\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}", [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($fnMatch.Success) {
        NOTE "shouldUseAgentic body:"
        $fnMatch.Value -split "`n" | ForEach-Object { INFO "  $_" }
    }
} else { FAIL "shouldUseAgentic not found in App.tsx" }

# Check isOllama guard
if (Has $app "isOllama && shouldUseAgentic") {
    FAIL "isOllama guard STILL EXISTS — Claude/OpenAI providers CANNOT use tools"
    NOTE "Fix: remove 'isOllama &&' from both send() and regenerateLast()"
} else {
    OK "isOllama guard removed — all providers can use tools"
}

# Check both send() and regenerateLast() call agenticStreamChat
$agCallCount = Count $app "agenticStreamChat\s*\("
if ($agCallCount -ge 2) { OK "agenticStreamChat called in $agCallCount places (send + regen)" }
elseif ($agCallCount -eq 1) { WARN "agenticStreamChat called only once — regenerateLast() may be missing it" }
else { FAIL "agenticStreamChat not called in App.tsx" }

# Check getCachedTools guard
if (Has $app "getCachedTools\(\)\.length > 0") { OK "getCachedTools guard present — won't start agent with 0 tools" }
else { WARN "No getCachedTools guard — agent may start with empty tool list" }

# ── SECTION 2: agenticStreamChat interface ────────────────────────────────────
HEAD "2. agenticStreamChat INTERFACE"

if (Has $ag "chatFn\?.*messages.*AbortSignal.*Promise<string>") {
    OK "chatFn optional override present (non-Ollama planner support)"
} else { WARN "chatFn override missing — non-Ollama providers cannot drive the planner" }

if (Has $ag "streamFn\?.*messages.*AbortSignal.*onToken") {
    OK "streamFn optional override present (non-Ollama final answer support)"
} else { WARN "streamFn override missing" }

if (Has $ag "opts\.chatFn") { OK "opts.chatFn used in planner call" }
else { WARN "opts.chatFn NOT used — chatFn override never executes" }

if (Has $ag "opts\.streamFn") { OK "opts.streamFn used in final answer" }
else { WARN "opts.streamFn NOT used" }

# ── SECTION 3: workspaceRoot / batchMode ─────────────────────────────────────
HEAD "3. WORKSPACE ROOT / BATCH MODE DETECTION"

if (Has $ag "async function getWorkspaceRoot") { OK "getWorkspaceRoot() defined in agentic.ts" }
else { FAIL "getWorkspaceRoot() missing from agentic.ts" }

if (Has $ag "slice(4)") {
        OK "\\?\\ prefix stripped in getWorkspaceRoot() via .slice(4)"
    } elseif (Has $ag "startsWith") {
        OK "\\?\\ prefix strip logic found in getWorkspaceRoot()"
    } else {
        FAIL "NO \\?\\ prefix stripping in getWorkspaceRoot() — Windows extended paths will break batchMode"
        NOTE "Rust canonicalize() adds \\?\\ prefix; without stripping, workspaceRoot != null check fails"
    }

if (Has $ag "const batchMode = workspaceRoot != null") { OK "batchMode = (workspaceRoot != null)" }
elseif (Has $ag "batchMode") { WARN "batchMode defined but condition unclear" }
else { FAIL "batchMode not defined" }

if (Has $ag "replace\(/\\\\/g") { OK "Backslash-to-slash normalization in getWorkspaceRoot()" }
else { WARN "No backslash normalization in getWorkspaceRoot() — Windows paths may break comparison" }

# ── SECTION 4: Path helpers ───────────────────────────────────────────────────
HEAD "4. PATH NORMALIZATION HELPERS (batchingExecutor)"

foreach ($fn in @("normalizeBatchPath", "isAbsPath", "toRelUnderRoot", "resolveBatchPath")) {
    if (Has $ag "function $fn") { OK "$fn defined" }
    else { FAIL "$fn MISSING — batch path resolution broken" }
}

# Check normalizeBatchPath strips \\?\
if (Has $ag "normalizeBatchPath" ) {
    $nbMatch = [regex]::Match($ag, "function normalizeBatchPath\([^)]*\)\s*\{[^}]+\}", [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($nbMatch.Success) {
        $body = $nbMatch.Value
        if ($body -match '\\\\\\\\?\\\\|startsWith') { OK "normalizeBatchPath strips \\?\\ prefix" }
        else { WARN "normalizeBatchPath may not strip \\?\\ prefix" }
        if ($body -match "replace.*\\\\/g") { OK "normalizeBatchPath converts backslashes" }
        else { WARN "normalizeBatchPath does not convert backslashes" }
        if ($body -match "\./") { OK "normalizeBatchPath strips leading ./" }
        else { WARN "normalizeBatchPath does not strip leading ./" }
    }
}

# Check toRelUnderRoot case-insensitive
if (Has $ag "toLowerCase|toLowerCase\(\)") { OK "Case-insensitive path comparison in toRelUnderRoot (Windows-safe)" }
else { WARN "No toLowerCase in path comparison — case mismatch on Windows will break root stripping" }

# ── SECTION 5: batchingExecutor tool interception ────────────────────────────
HEAD "5. batchingExecutor — TOOL INTERCEPTION"

$interceptedTools = @(
    @{ name="fs.write_file";     pattern='name === "fs\.write_file"' },
    @{ name="fs.create_directory"; pattern='name === "fs\.create_directory"' },
    @{ name="fs.copy_file";      pattern='name === "fs\.copy_file"' },
    @{ name="fs.move_file";      pattern='name === "fs\.move_file"' },
    @{ name="fs.rename_file";    pattern='name === "fs\.rename_file"' },
    @{ name="fs.*  (catch-all)"; pattern='name\.startsWith\("fs\."' }
)

foreach ($t in $interceptedTools) {
    if (Has $ag $t.pattern) { OK "$($t.name) intercepted in batchingExecutor" }
    else {
        if ($t.name -eq "fs.*  (catch-all)") { WARN "No fs.* catch-all — some tools pass to MCP unresolved" }
        else { WARN "$($t.name) NOT intercepted — goes to MCP unresolved (wrong dir)" }
    }
}

# Check ws_mkdir is used for create_directory
if (Has $ag 'invoke\(["`'"]ws_mkdir') { OK "fs.create_directory → ws_mkdir Tauri command (bypasses MCP sandbox)" }
elseif (Has $ag "fs\.create_directory") { WARN "fs.create_directory found but may still go to MCP (check if ws_mkdir is called)" }
else { WARN "fs.create_directory not intercepted at all" }

# Check copy uses ws_read_text + stage
if (Has $ag 'invoke.*ws_read_text.*srcPath|ws_read_text.*copy') {
    OK "fs.copy_file reads source via ws_read_text then stages to pendingWrites"
} elseif (Has $ag "ws_read_text") {
    INFO "ws_read_text present — check if it's used for copy interception"
} else {
    WARN "ws_read_text not used for copy — copies may go to wrong location"
}

# Check args.path mutation
if (Has $ag "args\.path = path") { OK "args.path mutated after normalization (step summary shows real path)" }
else { WARN "args.path not mutated — UI action cards show raw/wrong path" }

# Check absolute-outside-root throws
if (Has $ag "absolute path is outside workspace root") {
    OK "Absolute path outside root → throws Error (won't silently write elsewhere)"
} else {
    FAIL "No error thrown for absolute path outside root — model can write files OUTSIDE workspace silently"
}

# ── SECTION 6: pendingWrites path validation ──────────────────────────────────
HEAD "6. pendingWrites STAGING VALIDATION"

if (Has $ag "pendingWrites\.push") { OK "pendingWrites.push present" }
else { FAIL "pendingWrites.push missing — nothing ever staged" }

# Check for the guard that prevents pushing absolute paths
if (Has $ag "isAbsPath\(path\).*return.*batch paths must be relative") {
    OK "Guard: absolute paths rejected before push with clear error message"
} elseif (Has $ag "batch paths must be relative") {
    OK "Guard: absolute paths rejected before push"
} else {
    WARN "No guard before pendingWrites.push — absolute paths may be staged (ws_batch_apply will reject later)"
}

# Check empty path guard
if (Has $ag "!path.*return.*content.*empty path|resolved path is empty") {
    OK "Empty path guard present"
} else { WARN "No empty path guard — empty-string path may be staged" }

# ── SECTION 7: commitBatch ────────────────────────────────────────────────────
HEAD "7. BATCH COMMIT (commitBatch → ws_batch_apply)"

if (Has $ag "ws_batch_apply") { OK "ws_batch_apply Tauri command invoked" }
else { FAIL "ws_batch_apply NOT called — files never written" }

# Check correct parameter name (camelCase batchId vs snake_case batch_id)
if (Has $ag '"ws_batch_rollback".*batch_id:' -or (Has $ag 'batch_id: batchId')) {
    OK "ws_batch_rollback uses batch_id: (snake_case) — matches Rust parameter"
} elseif (Has $ag '"ws_batch_rollback".*batchId:') {
    FAIL "ws_batch_rollback uses batchId: (camelCase) — MISMATCH with Rust batch_id param — rollback silently fails"
} else {
    WARN "Cannot determine ws_batch_rollback parameter name — check manually"
}

# Check file verification after commit
if (Has $ag "ws_read_text.*w\.path|verifyError") {
    OK "Post-commit verification: reads each file back via ws_read_text"
    if (Has $ag "rollbackBatch.*batch_id.*verifyError|verifyError.*rollbackBatch") {
        OK "Verification failure → rollbackBatch called → prevents silent wrong-content commits"
    } else { WARN "Verify present but rollback on mismatch unclear" }
} else {
    FAIL "NO POST-COMMIT VERIFICATION — agent says 'done' even if ws_batch_apply silently failed"
    NOTE "Add: for each pendingWrite, invoke ws_read_text and compare content"
}

# Check success dispatch
if (Has $ag "nikolai:batch-committed") { OK "CustomEvent nikolai:batch-committed dispatched on success (WorkspacePanel auto-refresh)" }
else { WARN "No batch-committed event — WorkspacePanel won't auto-refresh after write" }

# ── SECTION 8: Rust workspace.rs ─────────────────────────────────────────────
HEAD "8. Rust workspace.rs VALIDATION"

if (Has $ws "fn sanitize_rel") { OK "sanitize_rel() present — protects against path traversal" }
else { FAIL "sanitize_rel() missing — SECURITY RISK" }

# Check what sanitize_rel rejects
if (Has $ws "Component::RootDir.*absolute paths not allowed") {
    OK "sanitize_rel rejects Unix absolute paths (/...)"
} else { WARN "sanitize_rel may not reject Unix absolute paths" }

if (Has $ws "Component::Prefix.*absolute paths not allowed") {
    OK "sanitize_rel rejects Windows drive prefixes (C:\\...)"
} else { FAIL "sanitize_rel does NOT reject Windows drive prefixes — absolute paths can slip through" }

if (Has $ws "Component::ParentDir.*not allowed") {
    OK "sanitize_rel rejects .. traversal"
} else { FAIL "sanitize_rel does NOT reject .. — directory traversal attack possible" }

# Check canonicalize adds \\?\
if (Has $ws "fs::canonicalize") {
    OK "ws_set_root uses fs::canonicalize (adds \\?\\ prefix on Windows — must be stripped in TS)"
    NOTE "This is WHY getWorkspaceRoot() must strip \\?\\ — if it doesn't, workspaceRoot != null but path comparisons fail"
} else { WARN "ws_set_root does not use canonicalize" }

# Check ws_read_text and ws_mkdir exist
if (Has $ws "pub fn ws_read_text") { OK "ws_read_text Tauri command present (needed for verify + copy)" }
else { FAIL "ws_read_text missing from workspace.rs — verify step and copy interception will fail" }

if (Has $ws "pub fn ws_mkdir") { OK "ws_mkdir Tauri command present (needed for create_directory)" }
else { FAIL "ws_mkdir missing from workspace.rs — fs.create_directory will fail in batch mode" }

# Check ws_batch_apply validates paths
if (Has $ws "fn ws_batch_apply") {
    OK "ws_batch_apply command present"
    # Check it calls sanitize_rel per file
    if (Has $ws "sanitize_rel.*bf\.path|normalize_rel_string.*bf\.path") {
        OK "ws_batch_apply calls sanitize_rel per file — each staged path re-validated in Rust"
    } else { WARN "ws_batch_apply may not re-validate paths — if TS sends absolute path, behavior undefined" }
} else { FAIL "ws_batch_apply missing from workspace.rs" }

# ── SECTION 9: Context trimming ───────────────────────────────────────────────
HEAD "9. CONTEXT WINDOW MANAGEMENT"

if (Has $ag "trimContext") { OK "trimContext() defined" }
else { FAIL "trimContext() missing — context grows unbounded, model forgets goal after 3-4 steps" }

if (Has $ag "MAX_CONTEXT_CHARS\s*=\s*\d+") {
    $maxCtxMatch = [regex]::Match($ag, "MAX_CONTEXT_CHARS\s*=\s*(\d+)")
    if ($maxCtxMatch.Success) {
        $maxCtx = [int]$maxCtxMatch.Groups[1].Value
        INFO "MAX_CONTEXT_CHARS = $maxCtx chars (~$([math]::Round($maxCtx/4)) tokens)"
        if ($maxCtx -lt 4000)  { WARN "MAX_CONTEXT_CHARS very low ($maxCtx) — agent may cut too much context" }
        elseif ($maxCtx -gt 20000) { WARN "MAX_CONTEXT_CHARS very high ($maxCtx) — may overflow 8B model context" }
        else { OK "MAX_CONTEXT_CHARS = $maxCtx (reasonable for 8B models)" }
    }
} else { WARN "MAX_CONTEXT_CHARS not found" }

if (Has $ag "KEEP_LAST_TOOL_RESULTS\s*=\s*\d+") {
    $kMatch = [regex]::Match($ag, "KEEP_LAST_TOOL_RESULTS\s*=\s*(\d+)")
    if ($kMatch.Success) { OK "KEEP_LAST_TOOL_RESULTS = $($kMatch.Groups[1].Value)" }
} else { WARN "KEEP_LAST_TOOL_RESULTS not found" }

# Check trimContext is called before each planner step
if (Has $ag "trimContext\(convo\)") { OK "trimContext called in planner loop" }
else { WARN "trimContext not called in planner loop — context grows unbounded" }

# ── SECTION 10: Plan parsing & retries ───────────────────────────────────────
HEAD "10. PLAN PARSING & RETRY LOGIC"

if (Has $ag "parsePlan") { OK "parsePlan() defined" }
else { FAIL "parsePlan() missing" }

if (Has $ag "stripCodeFences") { OK "stripCodeFences() present — handles model wrapping JSON in ```" }
else { WARN "No code fence stripping — if model wraps JSON in ``` it will fail to parse" }

if (Has $ag "MAX_PLAN_PARSE_RETRIES") {
    $rMatch = [regex]::Match($ag, "MAX_PLAN_PARSE_RETRIES\s*=\s*(\d+)")
    if ($rMatch.Success) { OK "MAX_PLAN_PARSE_RETRIES = $($rMatch.Groups[1].Value)" }
} else { WARN "No parse retry limit — may get stuck in infinite retry loop" }

if (Has $ag "consecutiveParseFailures") { OK "consecutiveParseFailures counter present" }
else { WARN "No parse failure counter — infinite loops possible" }

# Check planner output shape instructions
if (Has $ag '"action":"tool"' -and Has $ag '"action":"final"') {
    OK "Planner prompt includes both action:tool and action:final examples"
} else { WARN "Planner prompt may be missing output shape examples" }

# PATH RULE instruction
if (Has $ag "PATH RULE.*CRITICAL.*RELATIVE|ALWAYS use RELATIVE paths") {
    OK "PATH RULE (CRITICAL) in planner prompt — model told to use relative paths"
} else {
    FAIL "NO PATH RULE in planner prompt — model will freely output absolute paths (e.g. C:\\Users\\...)"
    NOTE "Model learns from conversation history. Old messages with ethan2x paths will be re-used unless we override."
}

# ── SECTION 11: Tool result formatting ───────────────────────────────────────
HEAD "11. TOOL RESULT FORMATTING"

if (Has $ag "formatToolResult") { OK "formatToolResult imported and used" }
else { WARN "formatToolResult not used — raw MCP output passed to model (may confuse it)" }

if (Has $ag "truncateResult") { OK "truncateResult present — large tool results capped" }
else { WARN "No result truncation — huge directory listings can overflow context" }

if (Has $ag "MAX_RESULT_CHARS") {
    $mMatch = [regex]::Match($ag, "MAX_RESULT_CHARS\s*=\s*(\d+)")
    if ($mMatch.Success) { INFO "MAX_RESULT_CHARS = $($mMatch.Groups[1].Value)" }
}

# Check isError handling
if (Has $ag "formatted\.isError") { OK "isError flag checked — failed tool results fed back to planner" }
else { WARN "isError not checked — failed tools may look like successes to planner" }

# ── SECTION 12: Live Ollama check ─────────────────────────────────────────────
HEAD "12. LIVE OLLAMA CHECK"

$port = 11434
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $ar  = $tcp.BeginConnect("127.0.0.1", $port, $null, $null)
    $ok  = $ar.AsyncWaitHandle.WaitOne(800, $false)
    $tcp.Close()
    if ($ok) {
        OK "Ollama is running on port 11434"
        try {
            $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 4
            $models = $tags.models
            if ($models.Count -gt 0) {
                OK "$($models.Count) model(s) available:"
                $models | ForEach-Object { INFO "  $($_.name)" }

                $toolModels = $models | Where-Object { $_.name -match "qwen|mistral|llama3\.1|deepseek|command" }
                if ($toolModels) { OK "Tool-capable model(s) found: $(($toolModels | Select-Object -First 3 name).name -join ', ')" }
                else { WARN "No known tool-capable models. Qwen2.5/Mistral/Llama3.1 recommended for structured JSON output" }

                $nomicModel = $models | Where-Object { $_.name -match "nomic-embed-text" }
                if ($nomicModel) { OK "nomic-embed-text available — semantic index will work" }
                else { NOTE "nomic-embed-text not pulled. Run: ollama pull nomic-embed-text" }
            } else {
                FAIL "Ollama running but no models installed — run: ollama pull qwen2.5:7b"
            }
        } catch { WARN "Ollama running but /api/tags failed" }
    } else { FAIL "Ollama NOT running on port 11434 — start: ollama serve" }
} catch { FAIL "Cannot check Ollama port" }

# ── SECTION 13: Manifest / workspace state ────────────────────────────────────
HEAD "13. WORKSPACE STATE (manifest.jsonl scan)"

$wsRoot = $null
# Try to read workspace root from a known location
$storageJs = "src\lib\storage.ts"
if (Test-Path $storageJs) {
    $stg = Get-Content $storageJs -Raw -EA SilentlyContinue
    $keyMatch = [regex]::Match($stg, 'nikolai\.ws\.root["`'']|ws.*root.*key')
    if ($keyMatch.Success) { INFO "Workspace root localStorage key found in storage.ts" }
}

# Scan for any manifest.jsonl in Documents
$manifestFiles = Get-ChildItem "$env:USERPROFILE\Documents" -Recurse -Filter "manifest.jsonl" -EA SilentlyContinue
if ($manifestFiles) {
    OK "Found $($manifestFiles.Count) manifest.jsonl file(s):"
    foreach ($mf in $manifestFiles | Select-Object -First 5) {
        INFO "  $($mf.FullName) ($([math]::Round($mf.Length/1KB,1)) KB)"
        # Read last 10 lines
        $mlines = Get-Content $mf.FullName -Tail 20 -EA SilentlyContinue
        if ($mlines) {
            $batchBegins = ($mlines | Where-Object { $_ -match "batch_apply_begin" }).Count
            $batchEnds   = ($mlines | Where-Object { $_ -match "batch_apply_end"   }).Count
            $writes      = ($mlines | Where-Object { $_ -match "batch_write"        }).Count
            INFO "  Last 20 lines: batch_apply_begin=$batchBegins, batch_apply_end=$batchEnds, batch_write=$writes"
            if ($batchBegins -gt $batchEnds) { WARN "  Incomplete batch (begin > end) — last batch may have failed mid-way" }
            elseif ($batchEnds -gt 0) { OK "  Last batch completed: $writes file(s) written" }
            else { NOTE "  No batch events in last 20 lines" }
        }
    }
} else {
    NOTE "No manifest.jsonl found under Documents — workspace may not have been used yet, or root is elsewhere"
}

# ── SECTION 14: Known failure mode summary ────────────────────────────────────
HEAD "14. KNOWN FAILURE MODES — ROOT CAUSE CHECKLIST"

$modes = @(
    @{
        id   = "FM-01"
        name = "Model outputs absolute path → batch rejected by Rust sanitize_rel"
        cause= "Planner sees old 'ethan2x' path in conversation history and reuses it"
        fix  = "PATH RULE in planner prompt (Fix 1) + resolveBatchPath converts abs→rel (Fix 2)"
        test = (Has $ag "PATH RULE.*CRITICAL.*RELATIVE|ALWAYS use RELATIVE") -and (Has $ag "resolveBatchPath")
    },
    @{
        id   = "FM-02"
        name = "\\?\\ prefix in workspaceRoot breaks path comparison"
        cause= "Rust canonicalize() adds \\?\\, getWorkspaceRoot() doesn't strip it"
        fix  = "Strip \\?\\ in getWorkspaceRoot() with startsWith check"
        test = (Has $ag "startsWith") -and (Has $ag "getWorkspaceRoot") -and (Has $ag "slice\(4\)")
    },
    @{
        id   = "FM-03"
        name = "fs.create_directory goes to MCP server (outside workspace sandbox)"
        cause= "MCP server allowed dirs don't include workspace root"
        fix  = "Intercept fs.create_directory → ws_mkdir Tauri command"
        test = (Has $ag "ws_mkdir")
    },
    @{
        id   = "FM-04"
        name = "fs.copy_file / fs.move_file write to MCP server's CWD"
        cause= "No interception — MCP resolves relative paths against its own CWD"
        fix  = "Intercept copy/move: ws_read_text source + stage to pendingWrites"
        test = (Has $ag "ws_read_text") -and (Has $ag "copy_file")
    },
    @{
        id   = "FM-05"
        name = "rollbackBatch silently does nothing"
        cause= "Rust expects batch_id: but TS was sending batchId: (camelCase mismatch)"
        fix  = "Change rollbackBatch invoke to { batch_id: batchId ?? null }"
        test = Has $ag 'batch_id: batchId'
    },
    @{
        id   = "FM-06"
        name = "Agent reports success even when commit failed"
        cause= "No read-back verification — ws_batch_apply 'OK' doesn't mean file is readable"
        fix  = "After commit: invoke ws_read_text per file, compare content, rollback on mismatch"
        test = Has $ag "verifyError"
    },
    @{
        id   = "FM-07"
        name = "isOllama guard blocks tools for Claude/OpenAI providers"
        cause= "agenticStreamChat only called when kind === 'ollama'"
        fix  = "Remove isOllama && from both send() and regenerateLast()"
        test = -not (Has $app "isOllama && shouldUseAgentic")
    },
    @{
        id   = "FM-08"
        name = "Context overflow — model forgets goal after 3-4 steps"
        cause= "Full conversation appended each step, exceeds 8B model context window"
        fix  = "trimContext: keep only original messages + last N tool results"
        test = Has $ag "trimContext\(convo\)"
    },
    @{
        id   = "FM-09"
        name = "fs.* tools other than write_file use MCP with relative paths → wrong folder"
        cause= "Only fs.write_file was intercepted; read/list/search pass through unresolved"
        fix  = "fs.* catch-all: prepend workspaceRoot to all relative path args before MCP call"
        test = Has $ag 'name\.startsWith\("fs\."'
    },
    @{
        id   = "FM-10"
        name = "Create-then-write broken: directory must exist before batch write"
        cause= "ws_batch_apply calls ensure_parent() but only if parent is within workspace"
        fix  = "For nested paths, mkdir chain happens inside ws_batch_apply (check Rust)"
        test = (Has $ws "ensure_parent") -or (Has $ws "create_dir_all")
    }
)

$passed = 0; $failed = 0
foreach ($m in $modes) {
    $status = if ($m.test) { "[FIXED]  "; $passed++ } else { "[BROKEN] "; $failed++ }
    $color  = if ($m.test) { "Green" } else { "Red" }
    Write-Host "  $status $($m.id): $($m.name)" -ForegroundColor $color
    $lines += "  $status $($m.id): $($m.name)"
    if (-not $m.test) {
        WARN "  Cause : $($m.cause)"
        NOTE "  Fix   : $($m.fix)"
    }
}

W White ""
W Green  "  FIXED  : $passed / $($modes.Count)"
W Red    "  BROKEN : $failed / $($modes.Count)"

if ($failed -gt 0) {
    W Yellow "`n  TOP PRIORITY FIXES (deploy to src/ then rebuild):"
    foreach ($m in $modes | Where-Object { -not $_.test } | Select-Object -First 5) {
        W Yellow "    → $($m.id): $($m.fix)"
    }
}

# ── Save log ──────────────────────────────────────────────────────────────────
$lines | Out-File $logFile -Encoding UTF8
W White "`n  Full report saved: $logFile`n"