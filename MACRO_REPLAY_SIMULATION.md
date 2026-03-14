# MACRO REPLAY SIMULATION REPORT

**Simulation Date:** 2026-03-13  
**Risk Classification:** LOW

---

## SIMULATED CHANGES

### Change 1: Add waitForEvent Helper

**Location:** TestRecorder.tsx, after line 103

```typescript
const lastSendTsRef = useRef<number>(0);

const waitForEvent = useCallback((kind: string, timeoutMs: number = 30000) => {
  return new Promise<void>((resolve, reject) => {
    const startTime = Date.now();
    const targetTs = lastSendTsRef.current;
    
    const check = () => {
      const hasEvent = eventsRef.current.some(
        e => e.kind === kind && e.ts > targetTs
      );
      
      if (hasEvent) {
        resolve();
      } else if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Timeout waiting for ${kind} after ${timeoutMs}ms`));
      } else {
        setTimeout(check, 100);
      }
    };
    
    check();
  });
}, []);
```

**Impact Analysis:**
- ✅ Pure function, no side effects
- ✅ Reads from eventsRef (already exists)
- ✅ Timeout prevents infinite loop
- ✅ No React state modifications

---

### Change 2: Modify replayScript()

**Location:** TestRecorder.tsx, line 454-487

**Before:**
```typescript
for (let i = 0; i < sends.length; i++) {
  const ev = sends[i];
  const text = String(ev.data.text);

  if (i > 0) {
    const prevSend = sends[i - 1];
    const gap = Math.min(ev.ts - prevSend.ts, 2000);
    await new Promise(r => setTimeout(r, gap));
  }

  const sendFn = (window as any).__nikolai_send;
  if (sendFn) {
    await sendFn(text);
  }
}
```

**After:**
```typescript
for (let i = 0; i < sends.length; i++) {
  const ev = sends[i];
  const text = String(ev.data.text);

  if (i > 0) {
    const prevSend = sends[i - 1];
    const gap = Math.min(ev.ts - prevSend.ts, 10000);
    await new Promise(r => setTimeout(r, gap));
  }

  const sendFn = (window as any).__nikolai_send;
  if (sendFn) {
    lastSendTsRef.current = Date.now();
    await sendFn(text);
    
    // Wait for response before next send
    await waitForEvent("stream_end", 30000);
  }
}
```

**Impact Analysis:**
- ✅ Uses existing `sendFn` (same as before)
- ✅ `waitForEvent` is async, doesn't block React
- ✅ Timeout prevents deadlock
- ✅ May be slower (acceptable for testing)

---

### Change 3: Mount TestRecorder in App.tsx

**Location:** App.tsx, before closing `</ErrorBoundary>`

```typescript
import TestRecorder from "./components/TestRecorder";

// In JSX:
{import.meta.env.DEV && <TestRecorder />}
```

**Impact Analysis:**
- ✅ DEV-only guard prevents production rendering
- ✅ Component already handles its own cleanup
- ✅ No changes to existing App logic

---

## COMPATIBILITY VERIFICATION

### send() Function

**Concern:** Could waitForEvent interfere with send()?

**Analysis:**
```typescript
// send() flow:
1. Add user message to state
2. Add empty assistant message
3. Call ollamaStreamChat or agenticStreamChat
4. Stream tokens via onToken
5. finalizeStreaming() completes
6. pushEvent("stream_end") ← waitForEvent resolves here

// waitForEvent flow:
1. Record lastSendTsRef.current
2. Poll eventsRef every 100ms
3. Resolve when stream_end event appears
4. Timeout after 30s

// No interference - waitForEvent just reads eventsRef
```

**Verdict:** ✅ COMPATIBLE

---

### Chat Pipeline

**Concern:** Could replay break chat state?

**Analysis:**
```typescript
// Replay calls same send() as user:
await sendFn(text);

// send() does:
setChats(prev => [...prev, userMsg, assistantMsg]);
// ... streaming logic ...

// waitForEvent just waits for stream_end event
// Doesn't modify any state
```

**Verdict:** ✅ COMPATIBLE

---

### Agent Routing

**Concern:** Could replay cause different routing decisions?

**Analysis:**
```typescript
// Routing depends on:
shouldUseAgentic(prompt) && getCachedTools().length > 0

// Same prompt → same routing (deterministic)
// Tool availability depends on MCP connection state

// Risk: If MCP disconnected during replay, routing may differ
// Mitigation: Document that MCP should be connected for replay
```

**Verdict:** ✅ COMPATIBLE (with MCP connected)

---

### MCP Tools

**Concern:** Could replay trigger unexpected tool execution?

**Analysis:**
```typescript
// Replay only sends messages:
await sendFn(text);

// Tool execution depends on agent routing:
if (shouldUseAgentic(text) && getCachedTools().length > 0) {
  // Agent mode → may call tools
} else {
  // Chat mode → no tools
}

// Same text → same routing → same tool calls
// This is EXPECTED behavior for regression testing
```

**Verdict:** ✅ COMPATIBLE (expected behavior)

---

## DEADLOCK ANALYSIS

### Scenario: stream_end Never Arrives

**Could this happen?**
- Yes, if:
  - Ollama server is down
  - Stream timeout fires
  - Network error

**Consequences without timeout:**
- ❌ Replay hangs forever
- ❌ User can't interact

**Consequences with timeout:**
- ✅ Replay fails with error after 30s
- ✅ User can retry or fix issue

**Verdict:** ✅ TIMEOUT PREVENTS DEADLOCK

---

## PERFORMANCE ANALYSIS

### Memory Impact

**eventsRef growth:**
```typescript
// eventsRef capped at 2000 events (existing code)
const capped = eventsRef.current.length >= 2000
  ? [...eventsRef.current.slice(1), ev]
  : [...eventsRef.current, ev];
```

**Verdict:** ✅ NO MEMORY LEAK

### CPU Impact

**Polling frequency:**
```typescript
setTimeout(check, 100);  // Check every 100ms
```

**Impact:**
- 10 checks per second while waiting
- Typical wait: 1-5 seconds
- Total checks: 10-50 per message
- Negligible CPU impact

**Verdict:** ✅ ACCEPTABLE

---

## REGRESSION CHECK

### Existing Tests

**Current test suite:**
- `sandbox.test.ts` — 18 tests (path safety, tools)
- `json_repair.test.ts` — 16 tests (JSON parsing)

**Impact of changes:**
- TestRecorder changes are isolated
- No changes to production code
- No changes to existing test files

**Verdict:** ✅ NO REGRESSIONS EXPECTED

### Existing Functionality

**Features to verify:**
| Feature | Status |
|---------|--------|
| Chat send/receive | ✅ Unchanged |
| Agent routing | ✅ Unchanged |
| Tool execution | ✅ Unchanged |
| Streaming | ✅ Unchanged |
| TTS | ✅ Unchanged |

**Verdict:** ✅ NO BREAKING CHANGES

---

## FINAL RISK CLASSIFICATION

| Category | Risk | Notes |
|----------|------|-------|
| **React State** | ✅ LOW | No state modifications |
| **Chat Pipeline** | ✅ LOW | Uses same send() function |
| **Agent Routing** | ✅ LOW | Deterministic routing |
| **Tool Execution** | ✅ LOW | Expected behavior |
| **Deadlock** | ✅ LOW | 30s timeout prevents |
| **Memory** | ✅ LOW | eventsRef already capped |
| **CPU** | ✅ LOW | 100ms polling interval |
| **Existing Tests** | ✅ LOW | Isolated changes |

**OVERALL RISK: LOW**

---

## RECOMMENDATION

**PROCEED WITH IMPLEMENTATION**

**Rationale:**
1. All compatibility checks passed
2. Timeout prevents deadlocks
3. No breaking changes to existing functionality
4. Isolated to DEV-only component
5. Additive changes only

**Implementation is SAFE.**
