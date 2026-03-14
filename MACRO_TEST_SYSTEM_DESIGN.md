# MACRO TEST SYSTEM DESIGN

**Design Date:** 2026-03-13  
**Status:** PROPOSED  
**Risk Level:** LOW

---

## OBJECTIVE

Enhance the existing TestRecorder replay system to support:

1. **Wait for response completion** before next send
2. **Content validation** of responses
3. **Tool call replay** (optional)
4. **CI integration** (export to Vitest format)

---

## CURRENT STATE

| Feature | Status |
|---------|--------|
| Event Recording | ✅ WORKING |
| Macro Storage | ✅ WORKING |
| Basic Replay | ⚠️ PARTIAL (sends only, no wait) |
| Auto-Assertions | ✅ WORKING (6 assertions) |
| Content Validation | ❌ NOT IMPLEMENTED |
| Tool Call Replay | ❌ NOT IMPLEMENTED |

---

## DESIGN PROPOSAL

### 1. Response Wait Mechanism

**Problem:** Replay sends messages without waiting for previous response

**Solution:** Add `waitForResponse()` helper

```typescript
// New helper in TestRecorder.tsx
const waitForResponse = useCallback((timeoutMs: number = 30000) => {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Response timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    
    const checkForResponse = () => {
      const hasResponse = eventsRef.current.some(
        e => e.kind === "stream_end" && e.ts > lastSendTsRef.current
      );
      
      if (hasResponse) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(checkForResponse, 100);
      }
    };
    
    checkForResponse();
  });
}, []);

// Updated replay loop
for (let i = 0; i < sends.length; i++) {
  const ev = sends[i];
  const text = String(ev.data.text);
  
  // Wait for gap
  if (i > 0) {
    const gap = Math.min(ev.ts - prevSend.ts, 2000);
    await new Promise(r => setTimeout(r, gap));
  }
  
  // Send message
  const sendFn = (window as any).__nikolai_send;
  if (sendFn) {
    lastSendTsRef.current = Date.now();
    await sendFn(text);
    
    // NEW: Wait for response before next send
    await waitForResponse(30000);
  }
}
```

**Benefits:**
- Prevents out-of-order responses
- Ensures state is stable before next action
- Catches timeout issues early

---

### 2. Content Validation

**Problem:** No validation of response content

**Solution:** Add user-defined assertions

#### 2.1 Assertion Editor UI

```typescript
interface UserAssertion {
  id: string;
  description: string;
  type: "contains" | "regex" | "length" | "custom";
  target: "response" | "tool_call" | "routing";
  pattern: string;
  expected: string | number;
}

// New UI component
function AssertionEditor({ 
  assertions, 
  onChange 
}: { 
  assertions: UserAssertion[]; 
  onChange: (a: UserAssertion[]) => void;
}) {
  return (
    <div>
      {assertions.map(a => (
        <AssertionRow 
          key={a.id} 
          assertion={a} 
          onChange={(updated) => {
            onChange(assertions.map(x => x.id === a.id ? updated : x));
          }}
          onDelete={() => onChange(assertions.filter(x => x.id !== a.id))}
        />
      ))}
      <button onClick={() => onChange([...assertions, newAssertion()])}>
        + Add Assertion
      </button>
    </div>
  );
}
```

#### 2.2 Assertion Types

| Type | Description | Example |
|------|-------------|---------|
| `contains` | Response contains text | "Hello" in response |
| `regex` | Response matches pattern | `/error.*code: \d+/` |
| `length` | Response length check | `response.length > 10` |
| `custom` | Custom JS expression | `response.includes("success")` |

#### 2.3 Validation Engine

```typescript
const validateAssertions = useCallback(
  (assertions: UserAssertion[], events: RecordedEvent[]): ValidationResult[] => {
    const results: ValidationResult[] = [];
    
    // Find all response events
    const responseEvents = events.filter(
      e => e.kind === "stream_end" && e.data.roundTripMs
    );
    
    for (const assertion of assertions) {
      const result: ValidationResult = {
        assertionId: assertion.id,
        description: assertion.description,
        pass: false,
        detail: "",
      };
      
      // Get response text (would need to capture it during recording)
      const responseText = getResponseText(events);
      
      switch (assertion.type) {
        case "contains":
          result.pass = responseText.includes(assertion.pattern);
          result.detail = result.pass 
            ? `Found "${assertion.pattern}"` 
            : `Missing "${assertion.pattern}"`;
          break;
          
        case "regex":
          const regex = new RegExp(assertion.pattern);
          result.pass = regex.test(responseText);
          result.detail = result.pass 
            ? `Matched /${assertion.pattern}/` 
            : `No match for /${assertion.pattern}/`;
          break;
          
        case "length":
          const length = parseInt(assertion.expected as string);
          result.pass = responseText.length > length;
          result.detail = `${responseText.length} chars (expected > ${length})`;
          break;
      }
      
      results.push(result);
    }
    
    return results;
  },
  []
);
```

---

### 3. Tool Call Replay

**Problem:** Tool calls are not replayed

**Solution:** Record and replay tool call expectations

#### 3.1 Tool Call Recording

```typescript
// Already captured via Tauri invoke patch
if (cmd.includes("mcp_call_tool")) {
  pushEvent("tool_call", `invoke: ${cmd}`, { 
    cmd, 
    args: safeArgs,
    toolName: (args as any)?.name,
    toolArgs: (args as any)?.args,
  });
}
```

#### 3.2 Tool Call Mocking

```typescript
interface ToolMock {
  toolName: string;
  mockResponse: any;
  callCount: number;
}

// During replay, mock tool responses
const replayWithMocks = useCallback(
  async (script: TestScript, mocks: ToolMock[]) => {
    // Patch mcp_call_tool to return mock responses
    const origInvoke = tauri.invoke.bind(tauri);
    tauri.invoke = async (cmd: string, args?: any) => {
      if (cmd.includes("mcp_call_tool")) {
        const toolName = args?.name;
        const mock = mocks.find(m => m.toolName === toolName);
        if (mock) {
          mock.callCount++;
          return mock.mockResponse;
        }
      }
      return origInvoke(cmd, args);
    };
    
    // Run replay...
    await replayScript(script);
    
    // Restore original invoke
    tauri.invoke = origInvoke;
  },
  []
);
```

---

### 4. CI Integration

**Problem:** Macros can't run in CI

**Solution:** Export to Vitest format

#### 4.1 Export Function

```typescript
const exportToVitest = useCallback((script: TestScript): string => {
  const assertions = script.assertions.map(a => `
    it("${a.description}", () => {
      expect(${a.pass}).toBe(true);
      // ${a.detail}
    });
  `).join("\n");
  
  return `
import { describe, it, expect } from "vitest";

describe("Macro Test: ${script.name}", () => {
  const recordedAt = "${script.recordedAt}";
  const durationMs = ${script.durationMs};
  const eventCount = ${script.events.length};
  
  it("recorded successfully", () => {
    expect(eventCount).toBeGreaterThan(0);
  });
  
  ${assertions}
  
  it("completed within expected duration", () => {
    expect(durationMs).toBeLessThan(60000); // 60s max
  });
});
  `.trim();
}, []);

// Download as .test.ts file
const exportButton = () => {
  const vitestCode = exportToVitest(selectedScript);
  const blob = new Blob([vitestCode], { type: "text/typescript" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${script.name}.test.ts`;
  a.click();
};
```

#### 4.2 CI Runner

```typescript
// tests/macro/example.test.ts
import { describe, it, expect } from "vitest";
import { runMacroScript } from "./macroRunner";
import exampleMacro from "./example.test.json";

describe("Macro Tests", () => {
  it("example macro", async () => {
    const results = await runMacroScript(exampleMacro);
    
    expect(results.assertions.every(a => a.pass)).toBe(true);
    expect(results.durationMs).toBeLessThan(60000);
  });
});
```

---

## IMPLEMENTATION PRIORITY

| Feature | Priority | Effort | Risk |
|---------|----------|--------|------|
| **Response Wait** | HIGH | LOW | LOW |
| **Content Validation** | HIGH | MEDIUM | LOW |
| **CI Export** | MEDIUM | LOW | LOW |
| **Tool Call Mocking** | LOW | HIGH | MEDIUM |

---

## FILE CHANGES REQUIRED

| File | Changes |
|------|---------|
| `src/components/TestRecorder.tsx` | Add `waitForResponse()`, assertion editor, CI export |
| `src/components/TestRecorder.tsx` | Add `UserAssertion` type, validation engine |
| `src/App.tsx` | No changes required (already exposes `__nikolai_send`) |

---

## TESTING STRATEGY

### Manual Testing

1. Record a simple conversation
2. Add content assertion ("response contains 'hello'")
3. Replay and verify assertion passes
4. Modify assertion to fail, verify failure detected

### Automated Testing

1. Export macro to Vitest format
2. Run in CI: `pnpm vitest tests/macro/`
3. Verify assertions pass

---

## RISK MITIGATION

| Risk | Mitigation |
|------|------------|
| **Replay too fast** | Response wait mechanism |
| **Different routing** | Document: ensure MCP connected |
| **Tool calls fail** | Optional mocking, skip if not needed |
| **Timing differences** | Document: timing not guaranteed |

---

## CONCLUSION

**The proposed enhancements are:**
- ✅ LOW RISK (no production code changes)
- ✅ LOW EFFORT (mostly TestRecorder.tsx changes)
- ✅ HIGH VALUE (automated regression testing)

**Recommended implementation order:**
1. Response wait mechanism
2. Content validation UI
3. CI export function
4. Tool call mocking (optional)

**Expected outcome:**
- Reliable macro replay
- Automated regression testing
- CI integration for macro tests
