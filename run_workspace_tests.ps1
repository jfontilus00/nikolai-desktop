# Workspace Implementation - Test Run
# Run this from PowerShell in the C:\Dev\Nikolai-desktop directory

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Workspace Implementation - Test Run" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Lint check
Write-Host "[1/4] Running TypeScript lint check..." -ForegroundColor Yellow
Write-Host ""
$result = pnpm -s lint
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Lint check failed!" -ForegroundColor Red
    exit 1
}
Write-Host "SUCCESS: Lint check passed!" -ForegroundColor Green
Write-Host ""

# Step 2: Typecheck
Write-Host "[2/4] Running TypeScript typecheck..." -ForegroundColor Yellow
Write-Host ""
$result = npx tsc --noEmit
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Typecheck failed!" -ForegroundColor Red
    exit 1
}
Write-Host "SUCCESS: Typecheck passed!" -ForegroundColor Green
Write-Host ""

# Step 3: Automated tests
Write-Host "[3/4] Running automated tests..." -ForegroundColor Yellow
Write-Host ""
$result = pnpm test:run
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Tests failed!" -ForegroundColor Red
    exit 1
}
Write-Host "SUCCESS: Tests passed!" -ForegroundColor Green
Write-Host ""

# Step 4: Tauri dev server
Write-Host "[4/4] Starting Tauri dev server..." -ForegroundColor Yellow
Write-Host ""
Write-Host "NOTE: This will launch the app. Press Ctrl+C to stop." -ForegroundColor Yellow
Write-Host ""
npx @tauri-apps/cli@1.5.9 dev

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "All checks completed successfully!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
