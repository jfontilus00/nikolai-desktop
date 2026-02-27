# Port Synchronization - Before & After

## Configuration Files

### 1. vite.config.ts

**BEFORE:**
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

**AFTER:**
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Change this to the port that your PowerShell probe printed (FOUND_OK_PORT=xxxx)
const DEV_PORT = 5180;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: DEV_PORT,
    strictPort: true,
  },
});
```

---

### 2. src-tauri\tauri.conf.json

**BEFORE:**
```json
{
    "build": {
        "devPath": "http://localhost:5173",
        ...
    }
}
```

**AFTER:**
```json
{
    "build": {
        "devPath": "http://127.0.0.1:5180",
        ...
    }
}
```

---

### 3. .eslintignore

**BEFORE:** (File may not have existed)

**AFTER:**
```
node_modules/
dist/
build/
src-tauri/target/
src-tauri/**/tauri-codegen-assets/
```

---

## Port Configuration Summary

| Component | Before | After |
|-----------|--------|-------|
| Vite Port | Auto (usually 5173) | **5180** |
| Vite Host | localhost | **127.0.0.1** |
| Tauri devPath | http://localhost:5173 | **http://127.0.0.1:5180** |
| Port Sync | ❌ Mismatch | ✅ Synchronized |

---

## Key Improvements

✅ **Port Synchronization**: Both Vite and Tauri now use the same port (5180)
✅ **IPv4 Consistency**: Using 127.0.0.1 instead of localhost for reliability
✅ **Strict Port Binding**: Vite won't fall back to another port if 5180 is busy
✅ **ESLint Ignored Files**: Build artifacts and generated files are ignored
✅ **Easy Port Changes**: DEV_PORT constant makes future changes simple

---

## Quick Commands

```powershell
# Kill existing processes and start dev
.\RUN_TAURI_DEV.ps1

# Check if port is excluded
.\CHECK_EXCLUDED_PORTS.ps1

# Manual start
taskkill /IM node.exe /F
npx @tauri-apps/cli@1.5.9 dev
```
