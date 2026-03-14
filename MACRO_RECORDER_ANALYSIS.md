# MACRO RECORDER ANALYSIS

**Analysis Date:** 2026-03-13  
**File Analyzed:** `src/components/TestRecorder.tsx` (853 lines)

---

## SYSTEM STATUS

**Classification: B — Recording works but replay is LIMITED**

| Feature | Status | Notes |
|---------|--------|-------|
| **Event Recording** | ✅ WORKING | Captures sends, routing, tools, TTS, Tauri invokes |
| **Macro Storage** | ✅ WORKING | JSON format, downloadable |
| **Macro Loading** | ✅ WORKING | Load from JSON file |
| **Replay Engine** | ⚠️ PARTIAL | Replays sends only, no validation |
| **Auto-Assertions** | ✅ WORKING | 6 auto-generated assertions |
| **Keyboard Shortcut** | ✅ WORKING | Ctrl+Shift+T toggles panel |

---

## HOW RECORDING WORKS

### Event Capture Pipeline

**1. Patches `window.__nikolai_send` (line 218-245)**
```typescript
// App.tsx exposes send() on window
(window as any).__nikolai_send = async (...args: unknown[]) => {
  const text = String(args[0] ?? "");
  
  pushEvent("send", `User: "${text.slice(0, 60)}"`, {
    text,
    timestamp: Date.now(),
  });
  
  const result = await orig(...args);
  
  const rtt = Date.now() - sendTimeRef.current;
  pushEvent("stream_end", `Response complete (${rtt}ms)`, {
    roundTripMs: rtt,
  });
  
  return result;
};
```

**Captures:**
- ✅ User message text
- ✅ Timestamp
- ✅ Round-trip timing

---

**2. Patches `console.log` (line 154-208)**
```typescript
console.log = (...args: unknown[]) => {
  // Forward to original
  origConsoleLog.current.apply(console, args);
  
  // Intercept structured log messages
  const msg = String(args[0] ?? "");
  
  if (msg.startsWith("[ROUTING]")) {
    pushEvent("routing", msg, { mode: "AGENT" | "CHAT", prompt: "..." });
  }
  else if (msg.startsWith("[TOOLS]")) {
    pushEvent("tools", msg, { total: 107, filtered: 5 });
  }
  // ... more patterns
};
```

**Captures:**
- ✅ Routing decisions (CHAT vs AGENT)
- ✅ Tool filter results
- ✅ TTS start/end
- ✅ Stream timeouts
- ✅ Agent tool calls

---

**3. Patches Tauri invoke (line 253-298)**
```typescript
tauri.invoke = async (cmd: string, args?: unknown) => {
  const interesting = [
    "voice_tts_speak",
    "voice_tts_speak_stream",
    "mcp_call_tool",
    "mcp_list_tools",
    "ws_set_root",
    "ws_get_root",
  ];
  
  if (interesting.some(k => cmd.includes(k))) {
    pushEvent("invoke" | "tts_start", `invoke: ${cmd}`, { cmd, args: safeArgs });
  }
  
  return origTauriInvoke.current!(cmd, args);
};
```

**Captures:**
- ✅ TTS invocations
- ✅ MCP tool calls
- ✅ Workspace commands

---

## EVENT TYPES RECORDED

| Event Kind | Description | Data Captured |
|------------|-------------|---------------|
| `send` | User sent a message | text, timestamp |
| `routing` | CHAT/AGENT decision | mode, prompt |
| `tools` | Tool filter result | total, filtered count |
| `tool_call` | Agent called a tool | raw log message |
| `tts_start` | TTS began speaking | text (truncated) |
| `tts_end` | TTS finished | - |
| `stream_start` | First token arrived | - |
| `stream_end` | Stream completed | roundTripMs |
| `timeout` | Stream timeout fired | raw message |
| `error` | Any error | raw message |
| `invoke` | Tauri invoke call | cmd, args |

---

## MACRO STORAGE FORMAT

### TestScript Interface (line 46-52)
```typescript
interface TestScript {
  name: string;
  recordedAt: string;        // ISO 8601 timestamp
  durationMs: number;        // Total recording duration
  events: RecordedEvent[];   // Array of events
  assertions: TestAssertion[]; // Auto-generated assertions
}
```

### RecordedEvent Interface (line 33-40)
```typescript
interface RecordedEvent {
  id: string;           // "ev-1", "ev-2", etc.
  ts: number;           // ms since recording started
  wallTs: number;       // absolute timestamp
  kind: EventKind;      // event type
  label: string;        // human-readable summary
  data: Record<string, unknown>; // event-specific data
}
```

### Example Macro JSON
```json
{
  "name": "test-2026-03-13",
  "recordedAt": "2026-03-13T20:00:00.000Z",
  "durationMs": 15000,
  "events": [
    {
      "id": "ev-1",
      "ts": 0,
      "wallTs": 1710360000000,
      "kind": "send",
      "label": "User: \"Hello\"",
      "data": { "text": "Hello", "timestamp": 1710360000000 }
    },
    {
      "id": "ev-2",
      "ts": 500,
      "wallTs": 1710360000500,
      "kind": "routing",
      "label": "[ROUTING] CHAT — \"Hello\"",
      "data": { "mode": "CHAT", "prompt": "Hello" }
    },
    {
      "id": "ev-3",
      "ts": 2000,
      "wallTs": 1710360002000,
      "kind": "stream_end",
      "label": "Response complete (1500ms)",
      "data": { "roundTripMs": 1500 }
    }
  ],
  "assertions": [
    {
      "description": "Each send produces a routing decision",
      "pass": true,
      "detail": "1 sends, 1 routing decisions"
    }
  ]
}
```

**Storage Location:** Downloaded as `.test.json` file (line 446)

---

## REPLAY MECHANISM

### How Replay Works (line 454-487)

```typescript
const replayScript = useCallback(async (script: TestScript) => {
  const sends = script.events.filter(e => e.kind === "send" && e.data.text);
  if (sends.length === 0) return;
  
  setRunResults(null);
  startRecording();  // Start recording to capture replay events
  
  for (let i = 0; i < sends.length; i++) {
    const ev = sends[i];
    const text = String(ev.data.text);
    
    // Wait for gap between sends (up to 2s max)
    if (i > 0) {
      const prevSend = sends[i - 1];
      const gap = Math.min(ev.ts - prevSend.ts, 2000);
      await new Promise(r => setTimeout(r, gap));
    }
    
    // Use the exposed send function
    const sendFn = (window as any).__nikolai_send;
    if (sendFn) {
      await sendFn(text);
    }
  }
  
  stopRecording();
  
  // Generate assertions on the replayed events
  const assertions = buildAssertions(eventsRef.current);
  setRunResults(assertions);
  setActiveTab("scripts");
}, [startRecording, stopRecording, buildAssertions]);
```

### Replay Limitations

| Limitation | Impact |
|------------|--------|
| **Only replays `send` events** | Does not replay tool calls, TTS, etc. |
| **Timing capped at 2s** | Original timing not fully preserved |
| **No validation of responses** | Only checks assertions, not content |
| **Requires `__nikolai_send` to be exposed** | Fails if App.tsx doesn't expose it |
| **No wait for response completion** | May send next message before previous completes |

---

## AUTO-ASSERTIONS

### Generated Assertions (line 347-420)

**6 auto-generated assertions:**

1. **Each send produces a routing decision**
   - Checks: `routings.length >= sends.length`

2. **No timeout fires**
   - Checks: `timeouts.length === 0`

3. **Tool filter never returns 0 tools**
   - Checks: `zeroFilter.length === 0`

4. **TTS start/end events are balanced**
   - Checks: `Math.abs(ttsStarts.length - ttsEnds.length) <= 1`

5. **Every send completes with a response**
   - Checks: `streamEnds.length >= sends.length`

6. **Average response time under 30s**
   - Checks: `avgRtt < 30000`

---

## KEYBOARD SHORTCUT

**Ctrl+Shift+T** (line 307-316)
```typescript
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "T") {
      e.preventDefault();
      setVisible(v => !v);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);
```

**Behavior:**
- ✅ Toggles TestRecorder panel visibility
- ✅ Works globally (window-level listener)
- ✅ Prevents default browser behavior

---

## INTEGRATION POINTS

### App.tsx Integration (line 1113-1114)
```typescript
// App.tsx exposes send on window for TestRecorder
(window as any).__nikolai_send = send;
return () => { 
  if ((window as any).__nikolai_send === send) 
    delete (window as any).__nikolai_send; 
};
```

**Status:** ✅ Properly wired

### TestRecorder in App Tree
```typescript
// Recommended placement (from TestRecorder.tsx comments)
{import.meta.env.DEV && <TestRecorder />}
```

**Status:** ⚠️ Must be manually added to App.tsx

---

## CURRENT STATUS SUMMARY

| Component | Status | Notes |
|-----------|--------|-------|
| **Event Capture** | ✅ WORKING | Patches console.log, __nikolai_send, Tauri invoke |
| **Event Storage** | ✅ WORKING | In-memory array, capped at 2000 events |
| **Macro Export** | ✅ WORKING | Downloads as .test.json |
| **Macro Import** | ✅ WORKING | Loads from JSON file |
| **Replay Engine** | ⚠️ PARTIAL | Only replays sends, no content validation |
| **Assertions** | ✅ WORKING | 6 auto-generated assertions |
| **UI Panel** | ✅ WORKING | Floating panel with tabs |
| **Keyboard Shortcut** | ✅ WORKING | Ctrl+Shift+T |

---

## MISSING FEATURES

| Feature | Priority | Effort |
|---------|----------|--------|
| **Wait for response completion** | HIGH | LOW |
| **Replay tool calls** | MEDIUM | MEDIUM |
| **Content validation** | HIGH | MEDIUM |
| **Visual diff of responses** | LOW | HIGH |
| **Batch replay (multiple scripts)** | LOW | LOW |
| **Export to CI format** | LOW | MEDIUM |

---

## RISK ASSESSMENT

**Risk Level: LOW**

**Why:**
1. Recording is passive (patches don't modify behavior)
2. Replay only sends messages (same as user typing)
3. All patches are reverted on unmount
4. DEV-only component (excluded from production)

**Potential Issues:**
1. Replay may send messages too fast (2s cap helps)
2. No validation of tool call results
3. Timing differences may cause different routing decisions

---

## RECOMMENDATIONS

### Immediate (LOW EFFORT)

1. **Add wait for response completion:**
   ```typescript
   // Wait for stream_end before next send
   await waitForEvent("stream_end");
   ```

2. **Add content validation:**
   ```typescript
   // Check response contains expected keywords
   assert(response.includes("expected"));
   ```

3. **Add TestRecorder to App.tsx:**
   ```typescript
   {import.meta.env.DEV && <TestRecorder />}
   ```

### Future (MEDIUM EFFORT)

1. **Replay tool calls** — Mock MCP responses
2. **Visual diff** — Compare old vs new responses
3. **CI integration** — Export to Vitest format

---

## CONCLUSION

**The TestRecorder is a functional macro recording system with:**
- ✅ Complete event capture
- ✅ JSON export/import
- ✅ Basic replay (sends only)
- ✅ Auto-assertions

**Missing for full automation:**
- ⚠️ Response content validation
- ⚠️ Tool call replay
- ⚠️ Proper wait for async operations

**Recommendation:** System is usable for manual testing. Add response validation for automated regression testing.
