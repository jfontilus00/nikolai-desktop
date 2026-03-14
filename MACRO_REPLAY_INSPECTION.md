# MACRO REPLAY INSPECTION REPORT

**Inspection Date:** 2026-03-13  
**Files Inspected:** `src/components/TestRecorder.tsx`, `src/App.tsx`

---

## EVENT RECORDING MECHANISM

### How Events Are Recorded

**1. eventsRef Storage (line 103)**
```typescript
const eventsRef = useRef<RecordedEvent[]>([]);
```
- Stored in React ref (persists across renders)
- Also synced to state: `setEvents(capped)` for UI updates
- Capped at 2000 events to prevent memory issues

**2. pushEvent Helper (line 118-138)**
```typescript
const pushEvent = useCallback((kind: EventKind, label: string, data: Record<string, unknown> = {}) => {
  if (!recordingRef.current) return;

  const ev: RecordedEvent = {
    id: `ev-${++eventCountRef.current}`,
    ts: Date.now() - startTimeRef.current,
    wallTs: Date.now(),
    kind,
    label,
    data,
  };

  const capped = eventsRef.current.length >= 2000
    ? [...eventsRef.current.slice(1), ev]
    : [...eventsRef.current, ev];

  eventsRef.current = capped;
  setEvents(capped);
}, [pushEvent]);
```

---

## REPLAY MECHANISM

### How replayScript() Works (line 454-487)

```typescript
const replayScript = useCallback(async (script: TestScript) => {
  const sends = script.events.filter(e => e.kind === "send" && e.data.text);
  if (sends.length === 0) return;

  setRunResults(null);
  startRecording();  // Start recording to capture replay events

  for (let i = 0; i < sends.length; i++) {
    const ev = sends[i];
    const text = String(ev.data.text);

    // Wait for gap between sends (up to 2s max to keep replay fast)
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
    // ❌ NO WAIT FOR stream_end HERE
  }

  stopRecording();

  // Generate assertions on the replayed events
  const assertions = buildAssertions(eventsRef.current);
  setRunResults(assertions);
  setActiveTab("scripts");
}, [startRecording, stopRecording, buildAssertions]);
```

**Current Issue:** No wait for `stream_end` before next send

---

## STREAM_END EVENT CAPTURE

### Where stream_end Events Are Generated (line 235-243)

```typescript
const result = await orig(...args);

const rtt = Date.now() - sendTimeRef.current;
pushEvent("stream_end", `Response complete (${rtt}ms)`, {
  roundTripMs: rtt,
});

return result;
```

**Triggered:** After `__nikolai_send` completes (response received)

**Data captured:**
- `roundTripMs` — Total round-trip time

---

## ASSERTION GENERATION

### How Assertions Are Built (line 347-420)

```typescript
const buildAssertions = useCallback((evs: RecordedEvent[]): TestAssertion[] => {
  const assertions: TestAssertion[] = [];

  const sends = evs.filter(e => e.kind === "send" && e.data.text);
  const routings = evs.filter(e => e.kind === "routing");
  const toolEvs = evs.filter(e => e.kind === "tools");
  const ttsStarts = evs.filter(e => e.kind === "tts_start" && !e.data.type);
  const ttsEnds = evs.filter(e => e.kind === "tts_end");
  const timeouts = evs.filter(e => e.kind === "timeout");
  const streamEnds = evs.filter(e => e.kind === "stream_end");

  // 1. Every send should get a routing decision
  if (sends.length > 0 && routings.length > 0) {
    assertions.push({
      description: "Each send produces a routing decision",
      pass: routings.length >= sends.length,
      detail: `${sends.length} sends, ${routings.length} routing decisions`,
    });
  }

  // 5. Every send should complete (stream_end)
  if (sends.length > 0) {
    assertions.push({
      description: "Every send completes with a response",
      pass: streamEnds.length >= sends.length,
      detail: `${sends.length} sends, ${streamEnds.length} completions`,
    });
  }

  return assertions;
}, []);
```

**Note:** Assertion #5 checks `streamEnds.length >= sends.length` but doesn't wait for them during replay.

---

## WINDOW.__NIKOLAI_SEND EXPOSURE

### App.tsx Integration (line 1113-1115)

```typescript
useEffect(() => {
  (window as any).__nikolai_send = send;
  return () => { 
    if ((window as any).__nikolai_send === send) 
      delete (window as any).__nikolai_send; 
  };
}, [send]);
```

**Status:** ✅ Properly exposed and cleaned up

---

## TESTRECORDER MOUNTING STATUS

### Current App.tsx Status

**TestRecorder is NOT currently mounted in App.tsx.**

**Required addition:**
```typescript
import TestRecorder from "./components/TestRecorder";

// In App component JSX:
{import.meta.env.DEV && <TestRecorder />}
```

**Status:** ⚠️ NOT MOUNTED — needs to be added

---

## IDENTIFIED ISSUES

| Issue | Location | Impact |
|-------|----------|--------|
| **No wait for stream_end** | replayScript() line 475 | Messages sent before previous response completes |
| **2s timing cap** | replayScript() line 468 | Original timing not fully preserved |
| **No response content validation** | buildAssertions() | Can't validate response text |
| **TestRecorder not mounted** | App.tsx | Component not rendered |

---

## RECOMMENDED FIXES

### Priority 1: Wait for stream_end

```typescript
// Add helper
const waitForStreamEnd = useCallback((timeoutMs: number = 30000) => {
  return new Promise<void>((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      const hasStreamEnd = eventsRef.current.some(
        e => e.kind === "stream_end" && e.ts > lastSendTsRef.current
      );
      
      if (hasStreamEnd) {
        resolve();
      } else if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Timeout waiting for stream_end after ${timeoutMs}ms`));
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}, []);

// Use in replay
await sendFn(text);
await waitForStreamEnd(30000);
```

### Priority 2: Mount TestRecorder

```typescript
// App.tsx
import TestRecorder from "./components/TestRecorder";

// In JSX:
{import.meta.env.DEV && <TestRecorder />}
```

### Priority 3: Remove timing cap

```typescript
// Replace:
const gap = Math.min(ev.ts - prevSend.ts, 2000);

// With:
const gap = Math.min(ev.ts - prevSend.ts, 10000); // 10s safety cap
```

---

## CONCLUSION

**Current replay mechanism is INCOMPLETE:**
- ✅ Events recorded correctly
- ✅ stream_end captured
- ✅ Assertions generated
- ❌ No wait for response completion
- ❌ TestRecorder not mounted

**Recommended fixes are LOW RISK:**
- Additive changes only
- No production code modifications
- DEV-only component
