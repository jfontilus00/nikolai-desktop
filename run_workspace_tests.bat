@echo off
echo ========================================
echo Workspace Implementation - Test Run
echo ========================================
echo.

echo [1/4] Running TypeScript lint check...
echo.
pnpm -s lint
if errorlevel 1 (
    echo ERROR: Lint check failed!
    pause
    exit /b 1
)
echo SUCCESS: Lint check passed!
echo.

echo [2/4] Running TypeScript typecheck...
echo.
npx tsc --noEmit
if errorlevel 1 (
    echo ERROR: Typecheck failed!
    pause
    exit /b 1
)
echo SUCCESS: Typecheck passed!
echo.

echo [3/4] Running automated tests...
echo.
pnpm test:run
if errorlevel 1 (
    echo ERROR: Tests failed!
    pause
    exit /b 1
)
echo SUCCESS: Tests passed!
echo.

echo [4/4] Starting Tauri dev server...
echo.
echo NOTE: This will launch the app. Press Ctrl+C to stop.
echo.
npx @tauri-apps/cli@1.5.9 dev
echo.
echo Tauri dev server stopped.
echo.

echo ========================================
echo All checks completed successfully!
echo ========================================
pause
