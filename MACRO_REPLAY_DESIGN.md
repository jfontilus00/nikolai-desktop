# MACRO REPLAY DESIGN DOCUMENT

**Design Date:** 2026-03-13  
**Status:** APPROVED FOR IMPLEMENTATION  
**Risk Level:** LOW

---

## OBJECTIVE

Improve TestRecorder macro replay reliability by:

1. Waiting for response completion before next send
2. Adding response content validation
3. Preserving deterministic replay timing
4. Maintaining DEV-only isolation

---

## DESIGN A: WAIT FOR RESPONSE COMPLETION

### Problem

Current replay sends messages without waiting for previous response:

```typescript
for (let i = 0; i < sends.length; i++) {
  await sendFn(text);
  // ❌ No wait for stream_end
}
```

### Solution: waitForEvent Helper

```typescript
// New ref to track last send timestamp
const lastSendTsRef = useRef<number>(0);

// New helper
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

### Modified Replay Loop

```typescript
for (let i = 0; i < sends.length; i++) {
  const ev = sends[i];
  const text = String(ev.data.text);

  // Wait for gap between sends (10s safety cap)
  if (i > 0) {
    const prevSend = sends[i - 1];
    const gap = Math.min(ev.ts - prevSend.ts, 10000);
    await new Promise(r => setTimeout(r, gap));
  }

  // Use the exposed send function
  const sendFn = (window as any).__nikolai_send;
  if (sendFn) {
    lastSendTsRef.current = Date.now();
    await sendFn(text);
    
    // NEW: Wait for response before next send
    await waitForEvent("stream_end", 30000);
  }
}
```

### Benefits

- Prevents out-of-order responses
- Ensures state is stable before next action
- Catches timeout issues early

### Risks

- **Deadlock if stream_end never arrives:** Mitigated by 30s timeout
- **Slower replay:** Acceptable for testing (accuracy > speed)

---

## DESIGN B: RESPONSE CONTENT VALIDATION

### Problem

Current assertions only check event counts, not response content.

### Solution: User-Defined Assertions

#### New Assertion Types

```typescript
interface UserAssertion {
  id: string;
  description: string;
  type: "contains" | "regex" | "startsWith" | "length";
  pattern: string;
  expected?: number;
}
```

#### Assertion Editor UI

Add new tab to TestRecorder:

```typescript
const [userAssertions, setUserAssertions] = useState<UserAssertion[]>([]);

function AssertionEditor() {
  return (
    <div>
      {userAssertions.map(a => (
        <div key={a.id}>
          <input value={a.description} onChange={...} />
          <select value={a.type} onChange={...}>
            <option value="contains">Contains</option>
            <option value="regex">Regex</option>
            <option value="startsWith">Starts with</option>
            <option value="length">Length</option>
          </select>
          <input value={a.pattern} onChange={...} />
          <button onClick={() => removeAssertion(a.id)}>×</button>
        </div>
      ))}
      <button onClick={addAssertion}>+ Add Assertion</button>
    </div>
  );
}
```

#### Validation Engine

```typescript
const validateUserAssertions = useCallback(
  (assertions: UserAssertion[], events: RecordedEvent[]): TestAssertion[] => {
    const results: TestAssertion[] = [];
    
    // Get response text from stream events (would need to capture it)
    // For now, use event labels as proxy
    const responseLabels = events
      .filter(e => e.kind === "stream_end")
      .map(e => e.label);
    
    for (const assertion of assertions) {
      const result: TestAssertion = {
        description: assertion.description,
        pass: false,
        detail: "",
      };
      
      // Check against all responses
      for (const label of responseLabels) {
        switch (assertion.type) {
          case "contains":
            if (label.includes(assertion.pattern)) {
              result.pass = true;
              result.detail = `Found "${assertion.pattern}"`;
            }
            break;
            
          case "regex":
            if (new RegExp(assertion.pattern).test(label)) {
              result.pass = true;
              result.detail = `Matched /${assertion.pattern}/`;
            }
            break;
            
          case "startsWith":
            if (label.startsWith(assertion.pattern)) {
              result.pass = true;
              result.detail = `Starts with "${assertion.pattern}"`;
            }
            break;
            
          case "length":
            if (label.length >= (assertion.expected || 0)) {
              result.pass = true;
              result.detail = `Length ${label.length} >= ${assertion.expected}`;
            }
            break;
        }
        if (result.pass) break;
      }
      
      if (!result.pass) {
        result.detail = `Pattern "${assertion.pattern}" not found`;
      }
      
      results.push(result);
    }
    
    return results;
  },
  []
);
```

### Limitations

- Response text not currently captured (only labels)
- Future enhancement: capture full response text

---

## DESIGN C: DETERMINISTIC REPLAY TIMING

### Problem

Current timing capped at 2s:

```typescript
const gap = Math.min(ev.ts - prevSend.ts, 2000);
```

### Solution: Configurable Timing with Safety Cap

```typescript
// Replace 2s cap with 10s cap
const gap = Math.min(ev.ts - prevSend.ts, 10000);
```

### Benefits

- Preserves more original timing
- Still has safety cap to prevent excessive delays
- Simple change, low risk

---

## IMPLEMENTATION PLAN

### Files to Modify

| File | Changes | Lines |
|------|---------|-------|
| `TestRecorder.tsx` | Add `lastSendTsRef`, `waitForEvent` | +30 |
| `TestRecorder.tsx` | Modify `replayScript()` | ~10 |
| `TestRecorder.tsx` | Add user assertion UI | ~50 |
| `App.tsx` | Mount TestRecorder | +2 |

### Implementation Order

1. Add `lastSendTsRef` and `waitForEvent` helper
2. Modify `replayScript()` to wait for `stream_end`
3. Change timing cap from 2s to 10s
4. Add user assertion UI (optional, phase 2)
5. Mount TestRecorder in App.tsx

### Testing Strategy

1. **Unit test:** `waitForEvent` resolves when event arrives
2. **Unit test:** `waitForEvent` rejects on timeout
3. **Integration test:** Replay simple macro, verify order
4. **Manual test:** Record conversation, replay, verify assertions

---

## RISK ASSESSMENT

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Deadlock on wait** | LOW | MEDIUM | 30s timeout |
| **Slower replay** | HIGH | LOW | Acceptable for testing |
| **React state issues** | LOW | LOW | Uses same send() function |
| **Memory leak** | LOW | LOW | eventsRef capped at 2000 |

**Overall Risk: LOW**

---

## CONCLUSION

**Design is SAFE for implementation:**
- Additive changes only
- No production code modifications
- DEV-only component
- Timeout prevents deadlocks
- Simple, focused changes

**Recommended to proceed with implementation.**
