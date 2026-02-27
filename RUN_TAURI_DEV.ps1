# Nikolai Desktop - Run Tauri Dev
# This script kills existing Node processes and starts Tauri dev

Write-Host "=== Killing existing Node processes ===" -ForegroundColor Yellow
taskkill /IM node.exe /F

Write-Host "`n=== Starting Tauri Dev (port 5180) ===" -ForegroundColor Green
npx @tauri-apps/cli@1.5.9 dev
