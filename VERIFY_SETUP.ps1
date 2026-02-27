# Nikolai Desktop - Setup Verification Commands

## Free ports if stuck dev servers exist
netstat -ano | findstr ":5173"
netstat -ano | findstr ":5174"
netstat -ano | findstr ":5175"
# If you see a PID, kill it:
# taskkill /PID <PID> /F

## Run verification
pnpm -s typecheck
pnpm -s lint
npx @tauri-apps/cli@1.5.9 dev

## If dev still fails with EACCES
# Check excluded ports:
# netsh interface ipv4 show excludedportrange protocol=tcp | findstr 5180
# netsh interface ipv6 show excludedportrange protocol=tcp | findstr 5180
# If 5180 is excluded, pick another port (e.g. 5190) and update vite.config.ts accordingly.
