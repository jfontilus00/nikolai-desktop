# MACRO TEST RISK ASSESSMENT

**Assessment Date:** 2026-03-13  
**System:** TestRecorder.tsx Macro Replay  
**Risk Level: LOW**

---

## EXECUTIVE SUMMARY

The existing TestRecorder macro system is **SAFE to use** for development testing.

**Why:**
1. Recording is passive (no behavior modification)
2. Replay uses the same `send()` function as user input
3. All patches are reverted on unmount
4. Component is DEV-only (excluded from production)

---

## COMPONENT ANALYSIS

### 1. Event Recording (LOW RISK)

**Mechanism:** Patches existing functions
```typescript
// Patches console.log
console.log = (...args) => {
  origConsoleLog.current.apply(console, args); // Always forwards
  // ... recording logic
};

// Patches window.__nikolai_send
(window as any).__nikolai_send = async (...args) => {
  pushEvent("send", ...);  // Records
  return await orig(...args);  // Forwards to original
};
```

**Risk:** None — original functions always called

**Impact if buggy:** Events not recorded (no false positives)

---

### 2. Macro Storage (LOW RISK)

**Mechanism:** In-memory array + JSON download
```typescript
const script: TestScript = {
  name,
  recordedAt: new Date().toISOString(),
  durationMs,
  events: eventsRef.current,
  assertions: buildAssertions(eventsRef.current),
};

// Download as JSON
const blob = new Blob([JSON.stringify(script, null, 2)]);
```

**Risk:** None — no persistence, no side effects

**Impact if buggy:** Lost recordings (no data corruption)

---

### 3. Macro Replay (MEDIUM RISK)

**Mechanism:** Iterates over recorded sends
```typescript
for (let i = 0; i < sends.length; i++) {
  const ev = sends[i];
  const text = String(ev.data.text);
  
  // Wait for gap (capped at 2s)
  const gap = Math.min(ev.ts - prevSend.ts, 2000);
  await new Promise(r => setTimeout(r, gap));
  
  // Call same send function as user
  const sendFn = (window as any).__nikolai_send;
  if (sendFn) {
    await sendFn(text);
  }
}
```

**Risk:** Timing differences may cause different behavior

**Potential Issues:**

| Issue | Likelihood | Impact |
|-------|------------|--------|
| **Sends too fast** | LOW | Server rate limiting |
| **No wait for response** | MEDIUM | Messages sent out of order |
| **Different routing** | LOW | Agent vs CHAT mode differs |
| **Tool calls not replayed** | MEDIUM | Incomplete test coverage |

---

### 4. Auto-Assertions (LOW RISK)

**Mechanism:** Validates event stream
```typescript
const assertions: TestAssertion[] = [
  {
    description: "Each send produces a routing decision",
    pass: routings.length >= sends.length,
    detail: `${sends.length} sends, ${routings.length} routing decisions`,
  },
  // ... more assertions
];
```

**Risk:** None — read-only validation

**Impact if buggy:** False pass/fail (no app damage)

---

## INTEGRATION RISKS

### React Event Flow (LOW RISK)

**Concern:** Could replay interfere with React state updates?

**Analysis:**
```typescript
// Replay calls same send() as user
const sendFn = (window as any).__nikolai_send;
await sendFn(text);

// send() updates React state internally
setChats(prev => [...prev, newMessage]);
```

**Verdict:** SAFE — uses same code path as user input

---

### Chat System (LOW RISK)

**Concern:** Could replay break chat state?

**Analysis:**
- Replay uses `__nikolai_send` which is the app's own send function
- Same validation, same state updates, same persistence

**Verdict:** SAFE — identical to user typing

---

### Tool Execution (MEDIUM RISK)

**Concern:** Replay doesn't replay tool calls, only sends

**Analysis:**
```typescript
// Recorded events may include:
// ev-1: send "read config.ts"
// ev-2: tool_call fs.read_file
// ev-3: stream_end

// Replay only does:
// send "read config.ts"
// (tool call happens naturally if agent mode)
```

**Verdict:** SAFE but INCOMPLETE — tool calls depend on agent routing

**Mitigation:** Ensure agent routing is deterministic for test inputs

---

### Agent Pipeline (LOW RISK)

**Concern:** Could replay cause different agent decisions?

**Analysis:**
- Agent routing depends on `shouldUseAgentic(prompt)`
- Same prompt → same routing (deterministic)
- Tool availability may vary (MCP connection state)

**Verdict:** SAFE if MCP is connected during replay

**Mitigation:** Check MCP status before replay

---

## TIMING RISKS

### Gap Timing (MEDIUM RISK)

**Current behavior:**
```typescript
const gap = Math.min(ev.ts - prevSend.ts, 2000);
await new Promise(r => setTimeout(r, gap));
```

**Issue:** Original gap may be >2s, but replay caps at 2s

**Impact:** Replay may be faster than original

**Mitigation:** Remove 2s cap or make configurable

---

### Response Wait (MEDIUM RISK)

**Current behavior:** No wait for `stream_end` before next send

**Issue:** May send message 2 before message 1 completes

**Impact:** Out-of-order responses, state corruption

**Mitigation:**
```typescript
// Wait for stream_end before next send
await waitForEvent("stream_end");
```

---

## PRODUCTION SAFETY

### DEV-Only Guard (SAFE)

```typescript
export default function TestRecorder() {
  if (!import.meta.env.DEV) return null;  // ✅ Never renders in prod
  // ...
}
```

**Verdict:** SAFE — excluded from production builds

---

### Patch Cleanup (SAFE)

```typescript
useEffect(() => {
  return () => {
    if (recordingRef.current) {
      unpatchConsole();
      unpatchSend();
      unpatchTauriInvoke();
      recordingRef.current = false;
    }
  };
}, [unpatchConsole, unpatchSend, unpatchTauriInvoke]);
```

**Verdict:** SAFE — patches reverted on unmount

---

## OVERALL RISK CLASSIFICATION

| Component | Risk Level | Notes |
|-----------|------------|-------|
| **Event Recording** | ✅ LOW | Passive, no side effects |
| **Macro Storage** | ✅ LOW | In-memory, JSON export |
| **Macro Replay** | ⚠️ MEDIUM | Timing issues possible |
| **Auto-Assertions** | ✅ LOW | Read-only validation |
| **React Integration** | ✅ LOW | Uses same send() function |
| **Tool Execution** | ⚠️ MEDIUM | Not replayed, depends on routing |
| **Production Safety** | ✅ LOW | DEV-only, patches cleaned up |

**OVERALL: LOW RISK**

---

## RECOMMENDED SAFEGUARDS

### Before Implementing

1. **Add response wait:**
   ```typescript
   // Wait for stream_end before next send
   const waitForResponse = () => new Promise<void>(resolve => {
     const check = (ev: RecordedEvent) => {
       if (ev.kind === "stream_end") {
         resolve();
       }
     };
     // Subscribe to events...
   });
   ```

2. **Add MCP status check:**
   ```typescript
   const mcpStatus = await invoke("mcp_status");
   if (!mcpStatus.connected) {
     alert("MCP not connected — tool calls may fail");
   }
   ```

3. **Add timing configuration:**
   ```typescript
   const [replaySpeed, setReplaySpeed] = useState(1.0);
   const gap = Math.min((ev.ts - prevSend.ts) * replaySpeed, 5000);
   ```

---

## CONCLUSION

**The TestRecorder macro system is SAFE for development use.**

**Risks are LOW because:**
1. Recording is passive
2. Replay uses same code paths as user
3. All patches are cleaned up
4. Component is DEV-only

**Recommended improvements:**
1. Wait for response completion
2. Check MCP status before replay
3. Make timing configurable

**NOT recommended for:**
- Production testing (DEV-only by design)
- Performance testing (timing not preserved)
- Security testing (patches could be detected)
