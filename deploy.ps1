# ============================================================
# NikolAi — Deploy latest fixes to project
# Run from project root: .\deploy.ps1
# ============================================================
# USAGE:
#   1. Download all output files from Claude to a folder, e.g. C:\Users\jackson\Downloads\nikolai-fixes\
#   2. Edit $fixesDir below to point to that folder
#   3. Run:  .\deploy.ps1
# ============================================================

$fixesDir = "$env:USERPROFILE\Downloads"   # ← change if your files are elsewhere

$ErrorActionPreference = "Stop"

function Deploy($src, $dst) {
    if (-not (Test-Path $src)) {
        Write-Host "  [SKIP]  $src (not found)" -ForegroundColor Yellow
        return
    }
    $dir = Split-Path $dst -Parent
    if (-not (Test-Path $dir)) { New-Item $dir -ItemType Directory -Force | Out-Null }
    Copy-Item $src $dst -Force
    Write-Host "  [OK]    $([IO.Path]::GetFileName($src)) → $dst" -ForegroundColor Green
}

Write-Host ""
Write-Host "  NikolAi Deploy — copying fixes to project" -ForegroundColor Cyan
Write-Host "  Source: $fixesDir" -ForegroundColor DarkGray
Write-Host ""

# TypeScript / React source files
Deploy "$fixesDir\agentic.ts"       "src\lib\agentic.ts"
Deploy "$fixesDir\App.tsx"          "src\App.tsx"
Deploy "$fixesDir\WorkspacePanel.tsx" "src\components\WorkspacePanel.tsx"

# Optional — only deploy if present in fixes dir
Deploy "$fixesDir\mcp.ts"           "src\lib\mcp.ts"
Deploy "$fixesDir\memory.ts"        "src\lib\memory.ts"
Deploy "$fixesDir\semanticIndex.ts" "src\lib\semanticIndex.ts"

# Rust files (need cargo build after)
Deploy "$fixesDir\workspace.rs"     "src-tauri\src\workspace.rs"
Deploy "$fixesDir\main.rs"          "src-tauri\src\main.rs"
Deploy "$fixesDir\mcp.rs"           "src-tauri\src\mcp.rs"

Write-Host ""
Write-Host "  Done. Now run:" -ForegroundColor White
Write-Host "    pnpm dev    (test in browser)" -ForegroundColor Cyan
Write-Host "    OR" -ForegroundColor DarkGray
Write-Host "    pnpm tauri dev    (test in Tauri window with full Rust backend)" -ForegroundColor Cyan
Write-Host ""