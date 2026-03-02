# ============================================================
# Atelier NikolAi Desktop — System & Code Inspection v2
# Checks: runtime tools, voice pack, V4 features, code health
# Run from project root: .\inspect.ps1
# ============================================================

$ErrorActionPreference = "SilentlyContinue"
$script:solid    = 0
$script:weak     = 0
$script:risk     = 0
$script:missing  = 0
$script:log      = @()
$script:findings = @()

function SOLID ($area, $msg) {
    Write-Host "  [SOLID]   $area -- $msg" -ForegroundColor Green
    $script:solid++
    $script:findings += [PSCustomObject]@{ Level="SOLID"; Area=$area; Message=$msg }
    $script:log += "[SOLID]   $area -- $msg"
}
function WEAK ($area, $msg) {
    Write-Host "  [WEAK]    $area -- $msg" -ForegroundColor Yellow
    $script:weak++
    $script:findings += [PSCustomObject]@{ Level="WEAK"; Area=$area; Message=$msg }
    $script:log += "[WEAK]    $area -- $msg"
}
function RISK ($area, $msg) {
    Write-Host "  [RISK]    $area -- $msg" -ForegroundColor Red
    $script:risk++
    $script:findings += [PSCustomObject]@{ Level="RISK"; Area=$area; Message=$msg }
    $script:log += "[RISK]    $area -- $msg"
}
function MISSING ($area, $msg) {
    Write-Host "  [MISSING] $area -- $msg" -ForegroundColor Magenta
    $script:missing++
    $script:findings += [PSCustomObject]@{ Level="MISSING"; Area=$area; Message=$msg }
    $script:log += "[MISSING] $area -- $msg"
}
function HEAD ($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
    $script:log += "`n==> $msg"
}
function INFO ($msg) {
    Write-Host "       $msg" -ForegroundColor DarkGray
    $script:log += "       $msg"
}
function ReadFile ($path) {
    if (Test-Path $path) { return Get-Content $path -Raw -ErrorAction SilentlyContinue }
    return ""
}
function CountMatches ($content, $pattern) {
    return ([regex]::Matches($content, $pattern)).Count
}
function HttpGet ($url) {
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        return $r.StatusCode
    } catch { return 0 }
}
function PortOpen ($port) {
    try {
        $t = New-Object System.Net.Sockets.TcpClient
        $a = $t.BeginConnect("127.0.0.1", $port, $null, $null)
        $ok = $a.AsyncWaitHandle.WaitOne(500, $false)
        $t.Close()
        return $ok
    } catch { return $false }
}
function FileSizeMB ($path) {
    if (Test-Path $path) {
        return [math]::Round((Get-Item $path).Length / 1MB, 1)
    }
    return 0
}

Write-Host ""
Write-Host "  Atelier NikolAi Desktop -- System Inspection v2" -ForegroundColor White
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
Write-Host ""

# ============================================================
HEAD "1. RUNTIME TOOLS"

# Node.js
$nodeVer = & node --version 2>$null
if ($nodeVer) {
    $nodeMajor = [int]($nodeVer -replace "v(\d+)\..*",'$1')
    if ($nodeMajor -ge 18) { SOLID "Node.js" "$nodeVer installed (>=18 required)" }
    else { RISK "Node.js" "$nodeVer is too old -- Vite 7 requires Node 18+" }
} else { RISK "Node.js" "Not found -- install from nodejs.org" }

# pnpm / npm
$pnpmVer = & pnpm --version 2>$null
if ($pnpmVer) { SOLID "pnpm" "v$pnpmVer installed" }
else {
    $npmVer = & npm --version 2>$null
    if ($npmVer) { WEAK "npm" "v$npmVer (pnpm preferred -- run: npm install -g pnpm)" }
    else { RISK "npm/pnpm" "Neither found" }
}

# Rust / cargo
$rustVer = & rustc --version 2>$null
if ($rustVer) { SOLID "Rust" "$rustVer" }
else { RISK "Rust" "Not found -- install from rustup.rs" }

# Tauri CLI
$tauriVer = & npx @tauri-apps/cli@1.5.9 --version 2>$null
if ($tauriVer) { SOLID "Tauri CLI" "v$tauriVer (via npx)" }
else { WEAK "Tauri CLI" "Could not verify -- run: npx @tauri-apps/cli@1.5.9 --version" }

# Git
$gitVer = & git --version 2>$null
if ($gitVer) { SOLID "Git" "$gitVer" }
else { WEAK "Git" "Not found -- source control unavailable" }

# ============================================================
HEAD "2. OLLAMA (LLM runtime)"

$ollamaRunning = PortOpen 11434
if ($ollamaRunning) {
    SOLID "Ollama" "Running on port 11434"

    # Get model list
    try {
        $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 4 -ErrorAction Stop
        $models = $tags.models
        if ($models -and $models.Count -gt 0) {
            SOLID "Ollama models" "$($models.Count) model(s) installed:"
            $models | ForEach-Object {
                $sizeMB = [math]::Round($_.size / 1MB, 0)
                INFO "  - $($_.name) ($sizeMB MB)"
            }
            # Check for vision model
            $visionModels = $models | Where-Object { $_.name -match "llava|gemma3|moondream|bakllava|minicpm" }
            if ($visionModels) { SOLID "Vision model" "Found: $($visionModels[0].name) -- image attachments will work" }
            else { WEAK "Vision model" "None found -- image attachments need llava/gemma3/moondream" }

            # Check for nomic-embed-text (V5 semantic search)
            $embedModel = $models | Where-Object { $_.name -match "nomic-embed-text|nomic" }
            if ($embedModel) { SOLID "Embedding model" "Found: $($embedModel[0].name) -- semantic search (V5) will work" }
            else { MISSING "Embedding model" "nomic-embed-text not installed. Run: ollama pull nomic-embed-text (~274 MB)" }
        } else {
            WEAK "Ollama models" "No models installed -- run: ollama pull qwen2.5:7b"
        }
    } catch {
        WEAK "Ollama API" "Running but /api/tags failed -- is it the correct version?"
    }
} else {
    RISK "Ollama" "Not running on port 11434 -- start with: ollama serve"
}

# ============================================================
HEAD "3. VOICE PACK"

# Find app data dir for voice binaries
$appData = $env:APPDATA
$voiceDir = "$appData\com.timanou.nikolai\voice"
INFO "Expected voice directory: $voiceDir"

if (Test-Path $voiceDir) {
    SOLID "Voice dir" "Exists: $voiceDir"
} else {
    MISSING "Voice dir" "Not found at $voiceDir -- voice pack not installed yet"
}

# Whisper server
$whisperExe = "$voiceDir\whisper-server.exe"
if (Test-Path $whisperExe) {
    $sz = FileSizeMB $whisperExe
    if ($sz -gt 10) { SOLID "whisper-server.exe" "$sz MB -- looks correct" }
    else { WEAK "whisper-server.exe" "$sz MB -- suspiciously small, may be corrupt" }
} else { MISSING "whisper-server.exe" "Not found in $voiceDir" }

# Whisper model
$whisperModel = "$voiceDir\ggml-base.en.bin"
if (Test-Path $whisperModel) {
    $sz = FileSizeMB $whisperModel
    if ($sz -gt 100) { SOLID "ggml-base.en.bin" "$sz MB -- correct size for base-en model" }
    elseif ($sz -gt 50) { WEAK "ggml-base.en.bin" "$sz MB -- smaller than expected (base ~150 MB)" }
    else { RISK "ggml-base.en.bin" "$sz MB -- too small, likely corrupt" }
} else { MISSING "ggml-base.en.bin" "Whisper base-en model not found -- STT will not work" }

# Piper
$piperExe = "$voiceDir\piper.exe"
if (Test-Path $piperExe) {
    $sz = FileSizeMB $piperExe
    if ($sz -gt 1) { SOLID "piper.exe" "$sz MB -- found" }
    else { WEAK "piper.exe" "$sz MB -- suspiciously small" }
} else { MISSING "piper.exe" "Not found -- TTS will not work" }

# Piper model
$piperModel = "$voiceDir\en_US-lessac-medium.onnx"
if (Test-Path $piperModel) {
    $sz = FileSizeMB $piperModel
    if ($sz -gt 30) { SOLID "en_US-lessac-medium.onnx" "$sz MB -- correct" }
    else { WEAK "en_US-lessac-medium.onnx" "$sz MB -- may be incomplete" }
} else { MISSING "en_US-lessac-medium.onnx" "Piper voice model not found" }

# Piper config
$piperConfig = "$voiceDir\en_US-lessac-medium.onnx.json"
if (Test-Path $piperConfig) { SOLID "en_US-lessac-medium.onnx.json" "Config file present" }
else { MISSING "en_US-lessac-medium.onnx.json" "Piper config missing -- TTS will fail even if model is present" }

# Voice servers actually running?
$whisperPort = PortOpen 9900
$piperPort   = PortOpen 9860
if ($whisperPort) { SOLID "Whisper server" "Responding on port 9900 -- ASR ready" }
else { WEAK "Whisper server" "Not running on 9900 -- use Voice tab -> Start servers" }
if ($piperPort) { SOLID "Piper server" "Responding on port 9860 -- TTS ready" }
else { WEAK "Piper server" "Not running on 9860 -- use Voice tab -> Start servers" }

# ============================================================
HEAD "4. MCP SERVER"

$mcpConfig = $null
$mcpRaw = $null
try {
    $mcpRaw = localStorage_key = [System.IO.File]::ReadAllText("$env:APPDATA\com.timanou.nikolai\nikolai.mcp.stdio.v1.json") 2>$null
} catch {}

# Check if mcp-hub is running (common port 3000 or check process)
$mcpHubProcess = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "mcp" -or $_.Path -match "mcp"
} 2>$null
if ($mcpHubProcess) { SOLID "mcp-hub process" "Node MCP process detected (PID $($mcpHubProcess[0].Id))" }
else { WEAK "mcp-hub process" "No MCP node process found -- connect via Tools tab first" }

# ============================================================
HEAD "5. PROJECT STRUCTURE"

# Required source files
$requiredFiles = @(
    "src\App.tsx",
    "src\components\ChatCenter.tsx",
    "src\components\ChatHistory.tsx",
    "src\components\RightPanel.tsx",
    "src\components\VoicePanel.tsx",
    "src\components\ToolsPanel.tsx",
    "src\components\WorkspacePanel.tsx",
    "src\lib\agentic.ts",
    "src\lib\mcp.ts",
    "src\lib\memory.ts",
    "src\lib\ollamaChat.ts",
    "src\lib\ollamaStream.ts",
    "src\lib\semanticIndex.ts",
    "src\lib\toolResult.ts",
    "src\lib\toolLog.ts",
    "src\lib\storage.ts",
    "src\lib\workspaceClient.ts",
    "src\lib\voiceSettings.ts",
    "src\lib\sttClient.ts",
    "src\lib\ttsClient.ts",
    "src\types.ts",
    "src-tauri\src\main.rs",
    "src-tauri\src\mcp.rs",
    "src-tauri\src\workspace.rs",
    "src-tauri\src\voice.rs",
    "src-tauri\Cargo.toml",
    "src-tauri\tauri.conf.json"
)

$missing_files = @()
foreach ($f in $requiredFiles) {
    if (-not (Test-Path $f)) { $missing_files += $f }
}
if ($missing_files.Count -eq 0) { SOLID "Source files" "All $($requiredFiles.Count) required files present" }
else {
    RISK "Source files" "$($missing_files.Count) required file(s) missing:"
    $missing_files | ForEach-Object { INFO "  MISSING: $_" }
}

# pdfjs-dist installed?
$pdfjs = Test-Path "node_modules\pdfjs-dist"
if ($pdfjs) { SOLID "pdfjs-dist" "Installed -- PDF attachment feature will work" }
else { MISSING "pdfjs-dist" "Not installed -- run: pnpm add pdfjs-dist" }

# diff package (WorkspacePanel diff view)
$diffPkg = Test-Path "node_modules\diff"
if ($diffPkg) { SOLID "diff" "Installed -- WorkspacePanel diff view will work" }
else { MISSING "diff" "Not installed -- run: pnpm add diff" }

# lazy_static in Cargo.toml
$cargoToml = ReadFile "src-tauri\Cargo.toml"
if ($cargoToml -match "lazy_static") { SOLID "Cargo.toml" "lazy_static dependency present -- voice.rs will compile" }
else { RISK "Cargo.toml" "lazy_static missing -- voice.rs will NOT compile. Add: lazy_static = '1'" }

# package.json version
$pkg = ReadFile "package.json"
if ($pkg -match '"version"\s*:\s*"([^"]+)"') {
    INFO "Frontend version: $($Matches[1])"
}

# Cargo.toml tauri version
if ($cargoToml -match 'tauri\s*=.*"([12]\.[^"]+)"') {
    INFO "Tauri version in Cargo.toml: $($Matches[1])"
    if ($Matches[1] -match "^1\.") {
        WEAK "Tauri version" "Using Tauri v1 -- works fine, v2 migration is a future consideration"
    }
}

# ============================================================
HEAD "6. V4 FEATURES CHECK"

$ag  = ReadFile "src\lib\agentic.ts"
$cc  = ReadFile "src\components\ChatCenter.tsx"
$rp  = ReadFile "src\components\RightPanel.tsx"
$mem = ReadFile "src\lib\memory.ts"
$vr  = ReadFile "src-tauri\src\voice.rs"

# Memory
if ($mem -match "loadMemory" -and $mem -match "addFact" -and $mem -match "formatMemoryForPrompt") {
    SOLID "V4-C Memory" "memory.ts complete -- loadMemory, addFact, formatMemoryForPrompt all present"
} else { MISSING "V4-C Memory" "memory.ts incomplete or missing" }

if ($rp -match "MemoryPanel" -and $rp -match "memory") {
    SOLID "V4-C Memory UI" "Memory tab present in RightPanel" }
else { MISSING "V4-C Memory UI" "Memory tab missing from RightPanel" }

if ($ag -match "loadMemory" -and $ag -match "memoryText") {
    SOLID "V4-C Memory injection" "agentic.ts injects memory into planner prompt" }
else { MISSING "V4-C Memory injection" "agentic.ts does not inject memory into planner" }

# Context grounding
if ($ag -match "silentTool" -and $ag -match "Context grounding") {
    SOLID "V4-B Context grounding" "Auto-reads project structure before agentic loop" }
else { MISSING "V4-B Context grounding" "Context grounding not present in agentic.ts" }

# PDF support
if ($cc -match "extractPdfText" -and $cc -match "pdfjs") {
    SOLID "V4-A PDF" "PDF extraction present in ChatCenter" }
else { MISSING "V4-A PDF" "PDF support missing from ChatCenter" }

if ($cc -match "pdfInputRef" -and $cc -match "pendingPdfs") {
    SOLID "V4-A PDF UI" "PDF input ref and pendingPdfs state present" }
else { MISSING "V4-A PDF UI" "PDF UI elements missing" }

# Voice sidecar
if ($vr -match "voice_status" -and $vr -match "voice_start_servers") {
    SOLID "V4 Voice sidecar" "voice.rs commands present -- auto-launch logic ready" }
else { MISSING "V4 Voice sidecar" "voice.rs missing or incomplete" }

$mainRs = ReadFile "src-tauri\src\main.rs"
if ($mainRs -match "voice::voice_status" -and $mainRs -match "mod voice") {
    SOLID "V4 Voice in main.rs" "voice module registered in main.rs" }
else { MISSING "V4 Voice in main.rs" "voice module not registered -- Tauri commands won't work" }

# System prompt
if ($cc -match "systemPromptOpen" -and $cc -match "onUpdateSystemPrompt") {
    SOLID "V3 System prompt" "Per-chat system prompt UI present" }
else { WEAK "V3 System prompt" "System prompt feature missing" }

# Image attachments
if ($cc -match "pendingImages" -and $cc -match "fileToBase64") {
    SOLID "V3 Image attachments" "Image paste/drag/paperclip all present" }
else { WEAK "V3 Image attachments" "Image attachment feature missing" }

# Context meter
if ($cc -match "estimatedTokens" -and $cc -match "ctxColor") {
    SOLID "V3 Context meter" "Live token estimate in header" }
else { WEAK "V3 Context meter" "Context meter missing" }

# ============================================================
HEAD "7. CODE HEALTH SPOT CHECK"

# agentic.ts core features
if ($ag -match "trimContext") { SOLID "agentic.ts" "Context window trimming present" }
else { RISK "agentic.ts" "No context trimming -- long tasks overflow model context" }

if ($ag -match "ws_batch_apply" -and $ag -match "rollbackBatch") { SOLID "agentic.ts" "Atomic batch writes + rollback" }
else { RISK "agentic.ts" "Batch write or rollback missing" }

if ($ag -match "MAX_PLAN_PARSE_RETRIES") { SOLID "agentic.ts" "Plan parse retry present" }
else { WEAK "agentic.ts" "No plan parse retry" }

# workspace.rs safety
$ws = ReadFile "src-tauri\src\workspace.rs"
if ($ws -match "sanitize_rel") { SOLID "workspace.rs" "Path traversal protection present" }
else { RISK "workspace.rs" "No path traversal check -- SECURITY RISK" }

if ($ws -match "\.nikolai_backups") { SOLID "workspace.rs" "Backup before overwrite present" }
else { WEAK "workspace.rs" "No backup mechanism found" }

# mcp.rs health
$mcpRs = ReadFile "src-tauri\src\mcp.rs"
if ($mcpRs -match "fail_all_pending") { SOLID "mcp.rs" "fail_all_pending on disconnect -- no hanging tool calls" }
else { WEAK "mcp.rs" "No fail_all_pending -- tool calls may hang on disconnect" }

# mcp.ts reconnect
$mcpTs = ReadFile "src\lib\mcp.ts"
if ($mcpTs -match "scheduleAutoReconnect\|autoReconnect") { SOLID "mcp.ts" "Auto-reconnect present" }
else { WEAK "mcp.ts" "No auto-reconnect" }

# ============================================================
HEAD "8. DISK SPACE"

$drive = Split-Path -Qualifier (Resolve-Path ".").Path
$disk = Get-PSDrive ($drive -replace ":","") -ErrorAction SilentlyContinue
if ($disk) {
    $freeGB = [math]::Round($disk.Free / 1GB, 1)
    INFO "Free space on $drive $freeGB GB"
    if ($freeGB -lt 5) { RISK "Disk space" "Less than 5 GB free -- builds and models may fail" }
    elseif ($freeGB -lt 20) { WEAK "Disk space" "${freeGB}GB free -- enough for now but models will fill this fast" }
    else { SOLID "Disk space" "${freeGB}GB free -- plenty of room" }
}

# Ollama model storage size
$ollamaDir = "$env:USERPROFILE\.ollama\models"
if (Test-Path $ollamaDir) {
    $ollamaGB = [math]::Round((Get-ChildItem $ollamaDir -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB, 1)
    INFO "Ollama models on disk: ${ollamaGB}GB ($ollamaDir)"
}

# ============================================================
HEAD "9. V5 SEMANTIC INDEX"

INFO "Checking V5 semantic search files..."

# semanticIndex.ts
$semTs = ReadFile "src\lib\semanticIndex.ts"
if ($semTs -match "buildIndex" -and $semTs -match "searchIndex" -and $semTs -match "embedText") {
    SOLID "semanticIndex.ts" "All core functions present: buildIndex, searchIndex, embedText"
} elseif ($semTs) {
    WEAK "semanticIndex.ts" "File exists but missing some functions -- redeploy semanticIndex.ts"
} else {
    MISSING "semanticIndex.ts" "NOT FOUND -- deploy src/lib/semanticIndex.ts"
}

if ($semTs -match "cosine\|cosineSimilarity") { SOLID "semanticIndex.ts" "Cosine similarity math present" }
elseif ($semTs) { RISK "semanticIndex.ts" "No cosine similarity function -- search results will be wrong" }

if ($semTs -match "QuotaExceededError") { SOLID "semanticIndex.ts" "localStorage quota guard present -- won't crash on large projects" }
elseif ($semTs) { WEAK "semanticIndex.ts" "No quota guard -- may crash silently on very large codebases" }

if ($semTs -match "SKIP_DIRS\|node_modules.*git") { SOLID "semanticIndex.ts" "SKIP_DIRS filter present -- won't embed node_modules or .git" }
elseif ($semTs) { RISK "semanticIndex.ts" "No SKIP_DIRS -- will try to embed node_modules (millions of files)" }

# agentic.ts V5 wiring
$agV5 = ReadFile "src\lib\agentic.ts"
if ($agV5 -match "semantic\.find" -and $agV5 -match "semanticExecutor") {
    SOLID "agentic.ts (V5)" "semantic.find tool wired into agent loop via semanticExecutor"
} else {
    MISSING "agentic.ts (V5)" "semantic.find not wired -- redeploy agentic.ts V5"
}

if ($agV5 -match "hasSemanticIndex" -and $agV5 -match "loadIndex") {
    SOLID "agentic.ts (V5)" "Index loaded and hasSemanticIndex flag checked before each run"
} else {
    MISSING "agentic.ts (V5)" "hasSemanticIndex/loadIndex missing from agentic.ts"
}

if ($agV5 -match "isSynthetic") {
    SOLID "agentic.ts (V5)" "Synthetic tool bypass present -- semantic.find skips MCP tool-not-found check"
} else {
    RISK "agentic.ts (V5)" "No isSynthetic bypass -- semantic.find will be blocked as 'tool not found'"
}

if ($agV5 -match "from.*semanticIndex") { SOLID "agentic.ts (V5)" "semanticIndex imported correctly" }
else { MISSING "agentic.ts (V5)" "semanticIndex not imported in agentic.ts" }

# WorkspacePanel V5 UI
$wpV5 = ReadFile "src\components\WorkspacePanel.tsx"
if ($wpV5 -match "startBuildIndex\|buildIndex" -and $wpV5 -match "Semantic Index") {
    SOLID "WorkspacePanel (V5)" "Build Index UI present"
} else {
    MISSING "WorkspacePanel (V5)" "No index build UI -- redeploy WorkspacePanel.tsx V5"
}

if ($wpV5 -match "indexProgress") { SOLID "WorkspacePanel (V5)" "Progress indicator state present" }
else { WEAK "WorkspacePanel (V5)" "No progress indicator -- user won't see build status" }

if ($wpV5 -match "AbortController\|abortBuildIndex") { SOLID "WorkspacePanel (V5)" "Index build can be cancelled mid-way" }
else { WEAK "WorkspacePanel (V5)" "No cancel support -- user stuck waiting if build hangs" }

# Check nomic-embed-text is pulled in Ollama
if ($ollamaRunning) {
    try {
        $tagsJson = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 4 -ErrorAction Stop
        $nomicPulled = $tagsJson.models | Where-Object { $_.name -match "nomic-embed-text" }
        if ($nomicPulled) {
            $nomicSize = [math]::Round($nomicPulled[0].size / 1MB, 0)
            SOLID "nomic-embed-text" "Pulled and ready ($nomicSize MB) -- semantic index can be built immediately"
        } else {
            MISSING "nomic-embed-text" "Not pulled yet. Run: ollama pull nomic-embed-text (~274 MB) then click Build Index in Workspace tab"
        }
    } catch {
        WEAK "nomic-embed-text" "Could not check Ollama model list"
    }
} else {
    WEAK "nomic-embed-text" "Ollama not running -- cannot check if nomic-embed-text is pulled"
}

# ============================================================
HEAD "10. SUMMARY"

$total = $script:solid + $script:weak + $script:risk + $script:missing

Write-Host ""
Write-Host "  SOLID   (working correctly)  : $($script:solid)"  -ForegroundColor Green
Write-Host "  WEAK    (works, improvable)  : $($script:weak)"   -ForegroundColor Yellow
Write-Host "  MISSING (V4 feature gap)     : $($script:missing)" -ForegroundColor Magenta
Write-Host "  RISK    (should fix now)     : $($script:risk)"   -ForegroundColor Red
Write-Host "  TOTAL checks                 : $total"
Write-Host ""

if ($script:risk -gt 0) {
    Write-Host "  RISK ITEMS -- fix before daily use:" -ForegroundColor Red
    $script:findings | Where-Object { $_.Level -eq "RISK" } | ForEach-Object {
        Write-Host "    ! $($_.Area): $($_.Message)" -ForegroundColor Red
    }
    Write-Host ""
}

if ($script:missing -gt 0) {
    Write-Host "  MISSING V4 FEATURES -- deploy output files to fix:" -ForegroundColor Magenta
    $script:findings | Where-Object { $_.Level -eq "MISSING" } | ForEach-Object {
        Write-Host "    * $($_.Area): $($_.Message)" -ForegroundColor Magenta
    }
    Write-Host ""
}

# Overall verdict
$voiceReady = (Test-Path $whisperExe) -and (Test-Path $whisperModel) -and (Test-Path $piperExe) -and (Test-Path $piperModel) -and (Test-Path $piperConfig)
$v4Ready    = ($ag -match "loadMemory") -and ($cc -match "extractPdfText") -and ($vr -match "voice_start_servers")
$v5Ready    = ($semTs -match "buildIndex") -and ($agV5 -match "semanticExecutor") -and ($wpV5 -match "startBuildIndex")

Write-Host "  VOICE PACK:  $(if ($voiceReady) { 'READY' } else { 'NOT READY -- see MISSING items above' })" -ForegroundColor $(if ($voiceReady) { 'Green' } else { 'Magenta' })
Write-Host "  V4 FEATURES: $(if ($v4Ready) { 'DEPLOYED' } else { 'PARTIALLY DEPLOYED -- see MISSING items' })" -ForegroundColor $(if ($v4Ready) { 'Green' } else { 'Yellow' })
Write-Host "  V5 SEMANTIC: $(if ($v5Ready) { 'DEPLOYED' } else { 'NOT DEPLOYED -- deploy 3 files + ollama pull nomic-embed-text' })" -ForegroundColor $(if ($v5Ready) { 'Green' } else { 'Yellow' })
Write-Host "  OLLAMA:      $(if ($ollamaRunning) { 'RUNNING' } else { 'NOT RUNNING -- start: ollama serve' })" -ForegroundColor $(if ($ollamaRunning) { 'Green' } else { 'Red' })

Write-Host ""
if ($script:risk -eq 0 -and $script:missing -eq 0) {
    Write-Host "  VERDICT: System fully operational. Safe for daily use and tauri build." -ForegroundColor Green
} elseif ($script:risk -eq 0) {
    Write-Host "  VERDICT: Core is healthy. Deploy missing V4 files then re-run inspect." -ForegroundColor Yellow
} else {
    Write-Host "  VERDICT: $($script:risk) risk item(s) need attention before building." -ForegroundColor Red
}

# Save report
$logFile = "nikolai-inspect-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$script:log | Out-File $logFile -Encoding UTF8
Write-Host "  Report saved: $logFile" -ForegroundColor DarkGray
Write-Host ""