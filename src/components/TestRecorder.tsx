/**
 * TestRecorder — Nikolai Desktop In-App Test Recorder
 *
 * DEV ONLY — automatically excluded from production builds.
 *
 * HOW IT WORKS:
 * - Zero modifications to existing code.
 * - Patches window.__nikolai_send (already exposed in App.tsx:1041)
 * - Patches console.log to capture structured [ROUTING] [TOOLS] [TTS] events
 * - Patches window.__TAURI_INTERNALS__ invoke to capture Tauri calls
 * - All patches are fully reverted on unmount.
 *
 * KEYBOARD SHORTCUT: Ctrl+Shift+T — toggle the recorder panel
 *
 * DROP-IN: Add <TestRecorder /> anywhere inside App's JSX tree.
 * Recommended: just before the closing </> in App.tsx:
 *   {import.meta.env.DEV && <TestRecorder />}
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type EventKind =
  | "send"        // user sent a message
  | "routing"     // CHAT or AGENT decision
  | "tools"       // filterToolsForPrompt result
  | "tool_call"   // agent called a tool
  | "tts_start"   // TTS began speaking
  | "tts_end"     // TTS finished
  | "stream_start"// first token arrived
  | "stream_end"  // stream completed
  | "timeout"     // stream timeout fired
  | "error"       // any error
  | "invoke";     // Tauri invoke call

interface RecordedEvent {
  id: string;
  ts: number;           // ms since recording started
  wallTs: number;       // absolute timestamp
  kind: EventKind;
  label: string;        // human-readable summary
  data: Record<string, unknown>;
}

interface TestScript {
  name: string;
  recordedAt: string;
  durationMs: number;
  events: RecordedEvent[];
  assertions: TestAssertion[];
}

interface TestAssertion {
  description: string;
  pass: boolean;
  detail: string;
}

// ── Colour map ────────────────────────────────────────────────────────────────

const KIND_COLOR: Record<EventKind, string> = {
  send:         "#60a5fa", // blue
  routing:      "#a78bfa", // purple
  tools:        "#34d399", // green
  tool_call:    "#fbbf24", // amber
  tts_start:    "#f472b6", // pink
  tts_end:      "#fb923c", // orange
  stream_start: "#22d3ee", // cyan
  stream_end:   "#86efac", // light green
  timeout:      "#f87171", // red
  error:        "#ef4444", // bright red
  invoke:       "#94a3b8", // grey
};

const KIND_ICON: Record<EventKind, string> = {
  send:         "→",
  routing:      "⎇",
  tools:        "🔧",
  tool_call:    "⚡",
  tts_start:    "🔊",
  tts_end:      "🔇",
  stream_start: "▶",
  stream_end:   "■",
  timeout:      "⏱",
  error:        "✗",
  invoke:       "📡",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function TestRecorder() {
  // Guard: only render in dev mode
  if (!import.meta.env.DEV) return null;

  const [visible, setVisible]       = useState(false);
  const [recording, setRecording]   = useState(false);
  const [events, setEvents]         = useState<RecordedEvent[]>([]);
  const [scripts, setScripts]       = useState<TestScript[]>([]);
  const [activeTab, setActiveTab]   = useState<"record" | "scripts">("record");
  const [runResults, setRunResults] = useState<TestAssertion[] | null>(null);

  const recordingRef   = useRef(false);
  const eventsRef      = useRef<RecordedEvent[]>([]);
  const startTimeRef   = useRef<number>(0);
  const eventCountRef  = useRef(0);

  // Track round-trip timing
  const sendTimeRef    = useRef<number>(0);
  const firstTokenRef  = useRef<boolean>(false);
  
  // Track last send timestamp for wait mechanism
  const lastSendTsRef  = useRef<number>(0);

  // Patched function refs — needed to restore on unmount
  const origConsoleLog    = useRef<typeof console.log>(console.log);
  const origNikolaiSend   = useRef<((...args: unknown[]) => unknown) | null>(null);
  const origTauriInvoke   = useRef<((...args: unknown[]) => unknown) | null>(null);

  // ── Event push helper ──────────────────────────────────────────────────────

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

    // Cap at 2000 events — prevents runaway memory on long sessions
    const capped = eventsRef.current.length >= 2000
      ? [...eventsRef.current.slice(1), ev]
      : [...eventsRef.current, ev];

    eventsRef.current = capped;
    setEvents(capped);
  }, []);

  // ── Wait for event helper ──────────────────────────────────────────────────
  // Waits for a specific event type to appear in eventsRef after lastSendTsRef.
  // Used during replay to ensure response completes before next send.

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

  // ── Console.log patch ──────────────────────────────────────────────────────
  // Intercepts structured log messages emitted by the existing codebase.
  // Zero modifications to source — we read logs as the public API.

  const patchConsole = useCallback(() => {
    // Guard against double-patching on React hot-reload
    if ((console as any).__nikolai_patched) return;
    (console as any).__nikolai_patched = true;

    origConsoleLog.current = console.log;

    console.log = (...args: unknown[]) => {
      // Always forward to original
      origConsoleLog.current.apply(console, args);

      if (!recordingRef.current) return;

      const msg = String(args[0] ?? "");

      // [ROUTING] CHAT — "message text"
      if (msg.startsWith("[ROUTING]")) {
        const isAgent = msg.includes("AGENT");
        const promptMatch = msg.match(/"([^"]+)"/);
        pushEvent("routing", msg, {
          mode: isAgent ? "AGENT" : "CHAT",
          prompt: promptMatch?.[1] ?? "",
        });
      }

      // [TOOLS] filtered 107 → 5 tools for: "..."
      else if (msg.startsWith("[TOOLS]")) {
        const numMatch = msg.match(/filtered (\d+) → (\d+)/);
        pushEvent("tools", msg, {
          total: numMatch ? parseInt(numMatch[1]) : null,
          filtered: numMatch ? parseInt(numMatch[2]) : null,
        });
      }

      // [TTS:1] ttsSpeak called
      else if (msg.startsWith("[TTS:1]") || msg.includes("ttsSpeak called")) {
        const textMatch = String(args[0]).match(/text=\s*(.+)/);
        pushEvent("tts_start", "TTS started", {
          text: textMatch?.[1]?.slice(0, 80) ?? "",
        });
      }

      // [TTS] isSpeaking released
      else if (msg.includes("isSpeaking released")) {
        pushEvent("tts_end", "TTS finished");
      }

      // [STREAM] safety timeout
      else if (msg.includes("[STREAM] safety timeout")) {
        pushEvent("timeout", "Stream timeout fired", { raw: msg });
      }

      // [AGENT] stream timeout — exiting
      else if (msg.includes("[AGENT] stream timeout")) {
        pushEvent("timeout", "Agent skipped retry", { raw: msg });
      }

      // [agentic] alias: "fs.write_file" → "dev-loop.dev.write_file"
      else if (msg.startsWith("[agentic] alias:")) {
        pushEvent("tool_call", msg, { raw: msg });
      }

      // [agentic] tool budget
      else if (msg.includes("[agentic] tool budget")) {
        pushEvent("tool_call", msg, { raw: msg });
      }
    };
  }, [pushEvent]);

  const unpatchConsole = useCallback(() => {
    console.log = origConsoleLog.current;
    delete (console as any).__nikolai_patched;
  }, []);

  // ── window.__nikolai_send patch ────────────────────────────────────────────
  // App.tsx:1041 exposes send() on window — we wrap it to capture sends.

  const patchSend = useCallback(() => {
    const orig = (window as any).__nikolai_send;
    if (!orig) return; // App not mounted yet

    origNikolaiSend.current = orig;

    (window as any).__nikolai_send = async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      sendTimeRef.current = Date.now();
      firstTokenRef.current = false;

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
  }, [pushEvent]);

  const unpatchSend = useCallback(() => {
    if (origNikolaiSend.current) {
      (window as any).__nikolai_send = origNikolaiSend.current;
      origNikolaiSend.current = null;
    }
  }, []);

  // ── Tauri invoke patch ────────────────────────────────────────────────────
  // Captures voice_tts_speak, voice_tts_speak_stream, and MCP tool invocations.

  const patchTauriInvoke = useCallback(() => {
    const tauri = (window as any).__TAURI_INTERNALS__ ?? (window as any).__TAURI__?.tauri;
    if (!tauri || typeof tauri.invoke !== "function") return;
    // Guard against double-patching
    if ((tauri as any).__nikolai_patched) return;
    (tauri as any).__nikolai_patched = true;

    origTauriInvoke.current = tauri.invoke.bind(tauri);

    tauri.invoke = async (cmd: string, args?: unknown) => {
      // Only record interesting commands, not internal Tauri ones
      const interesting = [
        "voice_tts_speak",
        "voice_tts_speak_stream",
        "mcp_call_tool",
        "mcp_list_tools",
        "ws_set_root",
        "ws_get_root",
      ];

      if (interesting.some(k => cmd.includes(k))) {
        const safeArgs = args && typeof args === "object"
          ? { ...(args as object), content: "[omitted]" } // don't log large content
          : args;

        if (cmd.includes("voice_tts")) {
          pushEvent("tts_start", `invoke: ${cmd}`, { cmd, args: safeArgs });
        } else {
          pushEvent("invoke", `invoke: ${cmd}`, { cmd, args: safeArgs });
        }
      }

      return origTauriInvoke.current!(cmd, args);
    };
  }, [pushEvent]);

  const unpatchTauriInvoke = useCallback(() => {
    const tauri = (window as any).__TAURI_INTERNALS__ ?? (window as any).__TAURI__?.tauri;
    if (tauri && origTauriInvoke.current) {
      tauri.invoke = origTauriInvoke.current;
      delete (tauri as any).__nikolai_patched;
      origTauriInvoke.current = null;
    }
  }, []);

  // ── Keyboard shortcut: Ctrl+Shift+T ───────────────────────────────────────

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

  // ── Recording controls ────────────────────────────────────────────────────

  const startRecording = useCallback(() => {
    eventsRef.current = [];
    eventCountRef.current = 0;
    startTimeRef.current = Date.now();
    recordingRef.current = true;

    patchConsole();
    patchSend();
    patchTauriInvoke();

    setEvents([]);
    setRunResults(null);
    setRecording(true);

    pushEvent("send", "▶ Recording started", { type: "meta" });
  }, [patchConsole, patchSend, patchTauriInvoke, pushEvent]);

  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);

    unpatchConsole();
    unpatchSend();
    unpatchTauriInvoke();
  }, [unpatchConsole, unpatchSend, unpatchTauriInvoke]);

  // ── Auto-assertions ───────────────────────────────────────────────────────
  // Generated automatically from the recorded event stream.

  const buildAssertions = useCallback((evs: RecordedEvent[]): TestAssertion[] => {
    const assertions: TestAssertion[] = [];

    const sends     = evs.filter(e => e.kind === "send" && e.data.text);
    const routings  = evs.filter(e => e.kind === "routing");
    const toolEvs   = evs.filter(e => e.kind === "tools");
    const ttsStarts = evs.filter(e => e.kind === "tts_start" && !e.data.type);
    const ttsEnds   = evs.filter(e => e.kind === "tts_end");
    const timeouts  = evs.filter(e => e.kind === "timeout");
    const streamEnds = evs.filter(e => e.kind === "stream_end");

    // 1. Every send should get a routing decision
    if (sends.length > 0 && routings.length > 0) {
      assertions.push({
        description: "Each send produces a routing decision",
        pass: routings.length >= sends.length,
        detail: `${sends.length} sends, ${routings.length} routing decisions`,
      });
    }

    // 2. No timeout should fire
    assertions.push({
      description: "No stream timeouts occurred",
      pass: timeouts.length === 0,
      detail: timeouts.length === 0
        ? "Clean — no timeouts"
        : `⚠ ${timeouts.length} timeout(s) fired`,
    });

    // 3. Tool filter should never return 0 tools
    const zeroFilter = toolEvs.filter(e => e.data.filtered === 0);
    assertions.push({
      description: "Tool filter never returns 0 tools",
      pass: zeroFilter.length === 0,
      detail: zeroFilter.length === 0
        ? "Filter always passed tools to planner"
        : `⚠ Filter returned 0 tools ${zeroFilter.length} time(s)`,
    });

    // 4. TTS starts and ends should be balanced (within ±1)
    if (ttsStarts.length > 0) {
      const balanced = Math.abs(ttsStarts.length - ttsEnds.length) <= 1;
      assertions.push({
        description: "TTS start/end events are balanced",
        pass: balanced,
        detail: `${ttsStarts.length} start(s), ${ttsEnds.length} end(s)`,
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

    // 6. Response time check
    const rttEvents = streamEnds.filter(e => typeof e.data.roundTripMs === "number");
    if (rttEvents.length > 0) {
      const avgRtt = rttEvents.reduce((s, e) => s + (e.data.roundTripMs as number), 0) / rttEvents.length;
      assertions.push({
        description: "Average response time under 30s",
        pass: avgRtt < 30000,
        detail: `Avg: ${(avgRtt / 1000).toFixed(1)}s`,
      });
    }

    return assertions;
  }, []);

  // ── Save test script ──────────────────────────────────────────────────────

  const saveScript = useCallback(() => {
    if (eventsRef.current.length === 0) return;

    const name = prompt("Test name:", `test-${new Date().toISOString().slice(0,10)}`);
    if (!name) return;

    const durationMs = eventsRef.current.length > 0
      ? eventsRef.current[eventsRef.current.length - 1].ts
      : 0;

    const script: TestScript = {
      name,
      recordedAt: new Date().toISOString(),
      durationMs,
      events: eventsRef.current,
      assertions: buildAssertions(eventsRef.current),
    };

    setScripts(prev => [...prev, script]);

    // Also download as JSON
    const blob = new Blob([JSON.stringify(script, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/\s+/g, "-")}.test.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildAssertions]);

  // ── Replay ────────────────────────────────────────────────────────────────
  // Replays all "send" events from a saved script with timing preserved.
  // Waits for each response to complete before sending the next message.

  const replayScript = useCallback(async (script: TestScript) => {
    const sends = script.events.filter(e => e.kind === "send" && e.data.text);
    if (sends.length === 0) return;

    setRunResults(null);
    startRecording();

    for (let i = 0; i < sends.length; i++) {
      const ev = sends[i];
      const text = String(ev.data.text);

      // Wait for gap between sends (10s safety cap to preserve timing)
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
        
        // Wait for response before next send (30s timeout)
        await waitForEvent("stream_end", 30000);
      }
    }

    stopRecording();

    // Generate assertions on the replayed events
    const assertions = buildAssertions(eventsRef.current);
    setRunResults(assertions);
    setActiveTab("scripts");
  }, [startRecording, stopRecording, buildAssertions, waitForEvent]);

  // ── Load script from JSON file ────────────────────────────────────────────

  const loadScript = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const script = JSON.parse(String(ev.target?.result)) as TestScript;
          setScripts(prev => [...prev, script]);
        } catch {
          alert("Invalid test script JSON");
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

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

  // ── Render ────────────────────────────────────────────────────────────────

  if (!visible) {
    return (
      <button
        onClick={() => setVisible(true)}
        title="Test Recorder (Ctrl+Shift+T)"
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 9999,
          background: recording ? "#ef4444" : "#1e293b",
          color: "#f1f5f9",
          border: "1px solid #334155",
          borderRadius: 8,
          padding: "6px 10px",
          fontSize: 12,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        }}
      >
        <span style={{ color: recording ? "#fca5a5" : "#64748b" }}>●</span>
        {recording ? "REC" : "TEST"}
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 9999,
        width: 420,
        maxHeight: "70vh",
        background: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        fontFamily: "monospace",
        fontSize: 12,
        color: "#e2e8f0",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        borderBottom: "1px solid #1e293b",
        background: "#0f172a",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: recording ? "#ef4444" : "#64748b", fontSize: 10 }}>●</span>
          <span style={{ fontWeight: 600, color: "#f1f5f9" }}>
            Nikolai Test Recorder
          </span>
          {recording && (
            <span style={{
              background: "#7f1d1d",
              color: "#fca5a5",
              borderRadius: 4,
              padding: "1px 6px",
              fontSize: 10,
              animation: "pulse 1s infinite",
            }}>
              RECORDING
            </span>
          )}
        </div>
        <button
          onClick={() => setVisible(false)}
          style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #1e293b" }}>
        {(["record", "scripts"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              padding: "6px 0",
              background: activeTab === tab ? "#1e293b" : "transparent",
              border: "none",
              color: activeTab === tab ? "#f1f5f9" : "#64748b",
              cursor: "pointer",
              fontSize: 11,
              fontFamily: "monospace",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {tab} {tab === "scripts" && scripts.length > 0 && `(${scripts.length})`}
          </button>
        ))}
      </div>

      {activeTab === "record" && (
        <>
          {/* Controls */}
          <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderBottom: "1px solid #1e293b" }}>
            {!recording ? (
              <button onClick={startRecording} style={btnStyle("#15803d", "#bbf7d0")}>
                ● Record
              </button>
            ) : (
              <button onClick={stopRecording} style={btnStyle("#7f1d1d", "#fca5a5")}>
                ■ Stop
              </button>
            )}
            <button
              onClick={saveScript}
              disabled={events.length === 0}
              style={btnStyle("#1e3a5f", "#93c5fd", events.length === 0)}
            >
              ↓ Save
            </button>
            <button
              onClick={() => { eventsRef.current = []; setEvents([]); }}
              disabled={recording}
              style={btnStyle("#1e293b", "#94a3b8", recording)}
            >
              Clear
            </button>
            <span style={{ marginLeft: "auto", color: "#64748b", lineHeight: "26px" }}>
              {events.length} events
            </span>
          </div>

          {/* Event stream */}
          <div style={{
            overflowY: "auto",
            flex: 1,
            padding: "4px 0",
          }}>
            {events.length === 0 && (
              <div style={{ color: "#475569", textAlign: "center", padding: "24px 12px" }}>
                Press ● Record, then use Nikolai normally.
                <br /><br />
                <span style={{ color: "#334155", fontSize: 11 }}>
                  Captures: routing, tools, TTS, Tauri invokes, timing
                </span>
              </div>
            )}
            {events.map(ev => (
              <div
                key={ev.id}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "3px 12px",
                  borderLeft: `2px solid ${KIND_COLOR[ev.kind]}22`,
                  marginBottom: 1,
                }}
              >
                <span style={{ color: "#475569", minWidth: 48, textAlign: "right" }}>
                  +{(ev.ts / 1000).toFixed(1)}s
                </span>
                <span style={{ color: KIND_COLOR[ev.kind], minWidth: 14 }}>
                  {KIND_ICON[ev.kind]}
                </span>
                <span style={{ color: "#cbd5e1", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ev.label}
                </span>
              </div>
            ))}
          </div>

          {/* Live assertions */}
          {events.length > 0 && !recording && (
            <AssertionPanel assertions={buildAssertions(events)} />
          )}
        </>
      )}

      {activeTab === "scripts" && (
        <>
          <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderBottom: "1px solid #1e293b" }}>
            <button onClick={loadScript} style={btnStyle("#1e3a5f", "#93c5fd")}>
              ↑ Load JSON
            </button>
            {scripts.length > 0 && (
              <span style={{ color: "#64748b", lineHeight: "26px", marginLeft: "auto" }}>
                {scripts.length} script{scripts.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {scripts.length === 0 ? (
              <div style={{ color: "#475569", textAlign: "center", padding: "24px 12px" }}>
                No saved scripts yet.
                <br />Record a session and press Save.
              </div>
            ) : (
              scripts.map((s, i) => (
                <ScriptCard
                  key={i}
                  script={s}
                  onReplay={() => replayScript(s)}
                  onDelete={() => setScripts(prev => prev.filter((_, j) => j !== i))}
                />
              ))
            )}

            {runResults && (
              <div style={{ padding: "8px 12px", borderTop: "1px solid #1e293b" }}>
                <div style={{ color: "#94a3b8", marginBottom: 6, fontWeight: 600 }}>
                  Last run results:
                </div>
                <AssertionPanel assertions={runResults} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AssertionPanel({ assertions }: { assertions: TestAssertion[] }) {
  const passed = assertions.filter(a => a.pass).length;
  const allPass = passed === assertions.length;

  return (
    <div style={{
      borderTop: "1px solid #1e293b",
      padding: "8px 12px",
      background: allPass ? "#052e16" : "#2d1a1a",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ color: allPass ? "#86efac" : "#fca5a5", fontWeight: 600 }}>
          {allPass ? "✓" : "✗"} {passed}/{assertions.length} assertions
        </span>
      </div>
      {assertions.map((a, i) => (
        <div key={i} style={{ display: "flex", gap: 6, padding: "2px 0" }}>
          <span style={{ color: a.pass ? "#4ade80" : "#f87171", minWidth: 14 }}>
            {a.pass ? "✓" : "✗"}
          </span>
          <span style={{ color: a.pass ? "#86efac" : "#fca5a5", flex: 1 }}>
            {a.description}
          </span>
          <span style={{ color: "#64748b", fontSize: 11 }}>{a.detail}</span>
        </div>
      ))}
    </div>
  );
}

function ScriptCard({
  script,
  onReplay,
  onDelete,
}: {
  script: TestScript;
  onReplay: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const passed = script.assertions.filter(a => a.pass).length;
  const allPass = passed === script.assertions.length;

  return (
    <div style={{ borderBottom: "1px solid #1e293b", padding: "8px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            color: allPass ? "#4ade80" : "#f87171",
            fontWeight: 700,
            minWidth: 20,
            cursor: "pointer",
          }}
          onClick={() => setExpanded(e => !e)}
        >
          {allPass ? "✓" : "✗"}
        </span>
        <span
          style={{ flex: 1, color: "#e2e8f0", cursor: "pointer" }}
          onClick={() => setExpanded(e => !e)}
        >
          {script.name}
        </span>
        <span style={{ color: "#475569", fontSize: 11 }}>
          {script.events.length} events · {(script.durationMs / 1000).toFixed(1)}s
        </span>
        <button onClick={onReplay} style={btnStyle("#1e3a5f", "#93c5fd")}>▶ Run</button>
        <button onClick={onDelete} style={btnStyle("#2d1a1a", "#fca5a5")}>✕</button>
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          <AssertionPanel assertions={script.assertions} />
        </div>
      )}
    </div>
  );
}

// ── Style helper ──────────────────────────────────────────────────────────────

function btnStyle(bg: string, color: string, disabled = false): React.CSSProperties {
  return {
    background: disabled ? "#1a1a2e" : bg,
    color: disabled ? "#334155" : color,
    border: "none",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 11,
    fontFamily: "monospace",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
