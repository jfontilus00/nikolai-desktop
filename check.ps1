# Nikolai Desktop -- Pre-release Diagnostic Script
# Run from project root: .\check.ps1
# ============================================================

$ErrorActionPreference = "SilentlyContinue"
$script:pass = 0
$script:warn = 0
$script:fail = 0
$script:log  = @()

function OK   ($msg) { Write-Host "  [OK]   $msg" -ForegroundColor Green;  $script:pass++; $script:log += "[OK]   $msg" }
function WARN ($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow; $script:warn++; $script:log += "[WARN] $msg" }
function FAIL ($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red;    $script:fail++; $script:log += "[FAIL] $msg" }
function HEAD ($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan;      $script:log += "`n==> $msg" }
function INFO ($msg) { Write-Host "       $msg" -ForegroundColor DarkGray; $script:log += "       $msg" }

# ============================================================
HEAD "1. TOOLCHAIN"

$nodeVer = node --version 2>$null
if ($nodeVer) { OK "Node $nodeVer" } else { FAIL "Node not found -- install from nodejs.org" }

$pnpmVer = pnpm --version 2>$null
if ($pnpmVer) { OK "pnpm $pnpmVer" } else { WARN "pnpm not found -- run: npm install -g pnpm" }

$npmVer = npm --version 2>$null
if ($npmVer) { OK "npm $npmVer" } else { WARN "npm not found" }

$rustVer = rustc --version 2>$null
if ($rustVer) { OK "$rustVer" } else { FAIL "Rust not found -- install from rustup.rs" }

$cargoVer = cargo --version 2>$null
if ($cargoVer) { OK "$cargoVer" } else { FAIL "Cargo not found" }

$tauriVer = cargo tauri --version 2>$null
if (-not $tauriVer) { $tauriVer = npx tauri --version 2>$null }
if ($tauriVer) { OK "Tauri CLI: $tauriVer" } else { WARN "Tauri CLI not found -- run: cargo install tauri-cli" }

# WebView2
$wv2a = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
$wv2b = Get-ItemProperty "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if ($wv2a -or $wv2b) { OK "WebView2 runtime installed" } else { FAIL "WebView2 not found -- download from microsoft.com/en-us/edge/webview2" }

# ============================================================
HEAD "2. PROJECT STRUCTURE"

$required = @(
    "src-tauri\Cargo.toml",
    "src-tauri\tauri.conf.json",
    "src-tauri\src\main.rs",
    "src-tauri\src\mcp.rs",
    "src-tauri\src\workspace.rs",
    "src\App.tsx",
    "src\lib\mcp.ts",
    "src\lib\agentic.ts",
    "src\lib\toolCmd.ts",
    "src\lib\toolResult.ts",
    "src\lib\toolLog.ts",
    "src\components\ChatCenter.tsx",
    "src\components\ToolApprovalModal.tsx",
    "package.json",
    "index.html"
)

foreach ($f in $required) {
    if (Test-Path $f) { OK $f } else { FAIL "MISSING: $f" }
}

# ============================================================
HEAD "3. DEPENDENCIES"

# pnpm lockfile
if (Test-Path "pnpm-lock.yaml") { OK "pnpm-lock.yaml present" }
elseif (Test-Path "package-lock.json") { OK "package-lock.json present" }
else { WARN "No lockfile found" }

# node_modules
if (Test-Path "node_modules") {
    $nmCount = (Get-ChildItem "node_modules" -Directory -ErrorAction SilentlyContinue).Count
    if ($nmCount -gt 10) {
        OK "node_modules present -- $nmCount dirs"
    } else {
        WARN "node_modules looks sparse ($nmCount dirs) -- run: pnpm install"
    }
} else {
    FAIL "node_modules missing -- run: pnpm install"
}

# Cargo.lock
if (Test-Path "src-tauri\Cargo.lock") { OK "Cargo.lock present" } else { WARN "Cargo.lock missing -- will be created on first build" }

# Key npm packages
$keyPkgs = @("react", "react-dom", "@tauri-apps/api", "react-markdown", "remark-gfm")
foreach ($pkg in $keyPkgs) {
    if (Test-Path "node_modules\$pkg") { OK "dep: $pkg" } else { FAIL "dep missing: $pkg -- run: pnpm install" }
}

# ============================================================
HEAD "4. TAURI CONFIG"

if (Test-Path "src-tauri\tauri.conf.json") {
    $conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($conf) {
        $identifier = $conf.tauri.bundle.identifier
        $version    = $conf.package.version
        if ($identifier -and $identifier -ne "com.tauri.dev") {
            OK "Bundle identifier: $identifier"
        } else {
            WARN "Bundle identifier is still default (com.tauri.dev) -- change before publishing"
        }
        if ($version) { OK "App version: $version" } else { WARN "Version not set in tauri.conf.json" }
    } else {
        FAIL "tauri.conf.json is not valid JSON"
    }
}

# ============================================================
HEAD "5. RUNTIME -- Ollama and node.exe"

# Ollama
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    $json = $resp.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
    $mc   = ($json.models | Measure-Object).Count
    OK "Ollama running -- $mc model(s)"
    foreach ($m in $json.models) { INFO "  model: $($m.name)" }
    if ($mc -eq 0) { WARN "No models loaded -- run: ollama pull <model>" }
} catch {
    WARN "Ollama not responding on port 11434 -- start it before using the app"
}

# node on PATH (required for mcp-hub)
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { OK "node.exe on PATH: $($nodeCmd.Source)" } else { FAIL "node.exe not on PATH -- mcp-hub will not start" }

# ============================================================
HEAD "6. TYPESCRIPT CHECK"

$tscBin = ".\node_modules\.bin\tsc.cmd"
if (-not (Test-Path $tscBin)) { $tscBin = "tsc" }

if (Test-Path "tsconfig.json") {
    INFO "Running tsc --noEmit (10-20s)..."
    $tscOut    = & $tscBin --noEmit 2>&1
    $tscErrors = $tscOut | Where-Object { $_ -match "error TS" }
    if ($tscErrors.Count -eq 0) {
        OK "TypeScript: no errors"
    } else {
        WARN "TypeScript: $($tscErrors.Count) error(s)"
        foreach ($e in $tscErrors | Select-Object -First 10) { INFO "  $e" }
        if ($tscErrors.Count -gt 10) { INFO "  ...and $($tscErrors.Count - 10) more" }
    }
} else {
    WARN "tsconfig.json not found -- skipping TypeScript check"
}

# ============================================================
HEAD "7. RUST CHECK"

INFO "Running cargo check in src-tauri (20-60s first run)..."
Push-Location "src-tauri"
$cargoOut  = cargo check 2>&1
Pop-Location

$cargoErrors   = $cargoOut | Where-Object { $_ -match "^error" }
$cargoWarnings = $cargoOut | Where-Object { $_ -match "^warning" }

if ($cargoErrors.Count -eq 0) {
    OK "Rust: no errors"
    if ($cargoWarnings.Count -gt 0) {
        WARN "Rust: $($cargoWarnings.Count) warning(s) -- not blocking"
        foreach ($w in $cargoWarnings | Select-Object -First 5) { INFO "  $w" }
    }
} else {
    FAIL "Rust: $($cargoErrors.Count) error(s)"
    foreach ($e in $cargoErrors | Select-Object -First 10) { INFO "  $e" }
}

# ============================================================
HEAD "8. PRIORITY FIXES DEPLOYED"

# P1 + P2: agentic.ts
if (Test-Path "src\lib\agentic.ts") {
    $ag = Get-Content "src\lib\agentic.ts" -Raw
    if ($ag -match "ws_batch_apply")  { OK "P1 batch write: ws_batch_apply in agentic.ts" }
    else                               { FAIL "P1 MISSING: ws_batch_apply not in agentic.ts -- redeploy agentic.ts" }
    if ($ag -match "trimContext")      { OK "P2 context trim: trimContext in agentic.ts" }
    else                               { FAIL "P2 MISSING: trimContext not in agentic.ts -- redeploy agentic.ts" }
} else { FAIL "src\lib\agentic.ts missing" }

# P3: mcp.rs
if (Test-Path "src-tauri\src\mcp.rs") {
    $rs = Get-Content "src-tauri\src\mcp.rs" -Raw
    if ($rs -match "Priority 3" -or ($rs -match "ensure_state\(\)" -and $rs -match "reader_loop")) {
        OK "P3 reader_loop fix: ensure_state in mcp.rs"
    } else {
        FAIL "P3 MISSING: reader_loop fix not found -- redeploy mcp.rs"
    }
}

# P4: ChatCenter
if (Test-Path "src\components\ChatCenter.tsx") {
    $cc = Get-Content "src\components\ChatCenter.tsx" -Raw
    if ($cc -match "agentStatus")      { OK "P4 status prop: agentStatus in ChatCenter.tsx" }
    else                                { FAIL "P4 MISSING: agentStatus not in ChatCenter.tsx -- redeploy ChatCenter.tsx" }
    if ($cc -match "ToolActionsBlock") { OK "P4 tool cards: ToolActionsBlock in ChatCenter.tsx" }
    else                                { FAIL "P4 MISSING: ToolActionsBlock not in ChatCenter.tsx -- redeploy ChatCenter.tsx" }
}

# P5: mcp.ts + App.tsx
if (Test-Path "src\lib\mcp.ts") {
    $mt = Get-Content "src\lib\mcp.ts" -Raw
    if ($mt -match "getCachedTools")  { OK "P5 cache: getCachedTools in mcp.ts" }
    else                               { FAIL "P5 MISSING: getCachedTools not in mcp.ts -- redeploy mcp.ts" }
}
if (Test-Path "src\App.tsx") {
    $ap = Get-Content "src\App.tsx" -Raw
    if ($ap -match "getCachedTools")  { OK "P5 App.tsx uses getCachedTools for /tools" }
    else                               { WARN "P5 CHECK: App.tsx may still call mcpListTools for /tools -- check import" }
}

# ============================================================
HEAD "9. DISK SPACE AND BUILD CACHE"

$disk = Get-PSDrive C -ErrorAction SilentlyContinue
if ($disk) {
    $freeGB = [math]::Round($disk.Free / 1GB, 1)
    if ($freeGB -gt 5)      { OK "Disk free: ${freeGB}GB on C:" }
    elseif ($freeGB -gt 2)  { WARN "Disk free: only ${freeGB}GB -- build may be tight" }
    else                     { FAIL "Disk free: only ${freeGB}GB -- very likely to fail" }
}

if (Test-Path "src-tauri\target\release") {
    $sz  = (Get-ChildItem "src-tauri\target\release" -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $szMB = [math]::Round($sz / 1MB, 0)
    OK "Release cache exists: ${szMB}MB -- incremental build will be faster"
} else {
    INFO "No release cache yet -- first build will take longer (normal)"
}

# Check dist folder (Vite output -- needed by Tauri)
if (Test-Path "dist") {
    $distCount = (Get-ChildItem "dist" -Recurse -ErrorAction SilentlyContinue).Count
    if ($distCount -gt 0) {
        OK "dist folder present: $distCount files"
    } else {
        WARN "dist folder is empty -- run: pnpm build  before: npm run tauri build"
    }
} else {
    WARN "dist folder missing -- Tauri build will create it automatically via pnpm build"
}

# ============================================================
HEAD "10. SUMMARY"

$total = $script:pass + $script:warn + $script:fail
Write-Host ""
Write-Host ("  Passed  : " + $script:pass + " / " + $total) -ForegroundColor Green
if ($script:warn -gt 0) { Write-Host ("  Warnings: " + $script:warn) -ForegroundColor Yellow }
if ($script:fail -gt 0) { Write-Host ("  Failed  : " + $script:fail) -ForegroundColor Red }
Write-Host ""

if ($script:fail -eq 0 -and $script:warn -le 2) {
    Write-Host "  VERDICT: Ready to build .exe" -ForegroundColor Green
    Write-Host "  Command: npm run tauri build" -ForegroundColor Cyan
} elseif ($script:fail -eq 0) {
    Write-Host "  VERDICT: Likely fine -- review warnings above first" -ForegroundColor Yellow
    Write-Host "  Command: npm run tauri build" -ForegroundColor Cyan
} else {
    Write-Host "  VERDICT: Fix the FAIL items before building" -ForegroundColor Red
    Write-Host "  Re-run this script after fixing to confirm." -ForegroundColor DarkGray
}

# Save log
$logFile = "nikolai-check-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log"
$script:log | Out-File $logFile -Encoding UTF8
Write-Host ""
Write-Host "  Log saved: $logFile" -ForegroundColor DarkGray
Write-Host ""
