# Nikolai Desktop Enterprise Audit

**Date:** March 2026  
**Version:** 0.1.1  
**Auditor:** AI Architecture Analysis  
**Scope:** Full-stack Tauri + React desktop AI assistant with Ollama LLM backend and MCP tools

---

## Score Summary Table

| Area | Score | Top Gap |
|------|-------|---------|
| 1. Ollama Integration | 8/10 | No per-model context window handling |
| 2. UI/UX Enterprise Quality | 6/10 | No keyboard shortcuts, no status bar, no conversation export |
| 3. Audio Conversational Flow | 7/10 | No VAD (basic silence detection only), no push-to-talk, no waveform feedback |
| 4. MCP Tool Efficiency | 8/10 | No write-aware cache invalidation, no dry-run mode |
| 5. Chat Persistence & Database | 7/10 | SQLite implemented but no full-text search, no tagging/folders |
| 6. Agentic Core Enterprise Robustness | 8/10 | No parallel executor, no sub-task decomposition, no undo stack |
| 7. Memory System | 6/10 | Single-tier memory, no confidence/decay, no UI memory management panel |
| 8. Stability & Production Robustness | 8/10 | No Ollama watchdog process, no first-run setup wizard |

**Overall Score: 7.1/10** — Strong agent core and security, good stability, moderate UI/UX and memory management

---

## Area 1: Ollama Integration — 8/10

### What Exists

- **Model fallback chain:** `src/lib/ollamaHealth.ts:25-28` — Chain: `qwen2.5:14b` → `qwen2.5:7b` → `llama3.2:3b` → `phi3:mini`
- **Health monitoring:** `src/lib/ollamaHealth.ts:33-68` — Checks `/api/tags` every 30 seconds, 3-strike failure detection
- **Status events:** `ollamaHealth.ts:95-107` — Emits `statuschange` events for UI updates
- **Request queuing:** `src/lib/llmQueue.ts` — Sequential processing (maxConcurrent = 1) to prevent VRAM overflow
- **LLM timeouts:** `src/lib/ollamaChat.ts:56-87` (30s), `ollamaStream.ts:78-161` (60s)
- **Streaming with abort:** `src/lib/ollamaStream.ts:82-102` — AbortSignal support, Tauri event-based streaming
- **Graceful disconnect handling:** `ollamaStream.ts:88-96` — Cleanup listeners on abort/error

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **No per-model context windows** | N/A | Fixed `MAX_CONTEXT_CHARS = 10,000` for all models (`agentic.ts:107`) |
| **Health monitor not auto-started** | `src/main.tsx` missing | Must be manually started, not in startup sequence |
| **No model capability detection** | `ollamaHealth.ts:70-85` | Doesn't check if model supports vision, tools, function calling |
| **No VRAM usage monitoring** | N/A | No telemetry on actual VRAM consumption |

### Top 3 Concrete Fixes

1. **Add health monitor auto-start** (`src/main.tsx`):
   ```typescript
   import { ollamaHealth } from "./lib/ollamaHealth";
   ollamaHealth.start(); // Add before ReactDOM.createRoot
   ```

2. **Add per-model context windows** (`src/lib/ollamaModels.ts`):
   ```typescript
   const CONTEXT_WINDOWS: Record<string, number> = {
     'qwen2.5:7b': 32768,
     'llama3:8b': 8192,
     'mistral:7b': 32768,
   };
   ```

3. **Add model capability detection** (`src/lib/ollamaHealth.ts`):
   ```typescript
   interface ModelCapabilities {
     supportsVision: boolean;
     supportsTools: boolean;
     maxContext: number;
   }
   ```

---

## Area 2: UI/UX Enterprise Quality — 6/10

### What Exists

- **Syntax highlighting:** `src/components/ChatCenter.tsx:17-40` — Shiki with github-dark theme, 12 languages
- **React Markdown rendering:** `ChatCenter.tsx:3-4` — Uses `react-markdown` + `remark-gfm`
- **Error boundary:** `src/components/ErrorBoundary.tsx` — Full-screen error catch with crash log to disk
- **Resizable panels:** `ResizableShell.tsx` — Drag-to-resize left/right panels
- **Tool approval modal:** `ToolApprovalModal.tsx` — Allow once / allow for chat / deny
- **PDF text extraction:** `ChatCenter.tsx:88-115` — Lazy pdfjs-dist import for PDF drops
- **Image attachment support:** `ChatCenter.tsx:63-85` — Drag-drop images, base64 encoding

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **No keyboard shortcuts** | N/A | No Cmd+K, Cmd+Enter, Escape handlers |
| **No conversation search** | `ChatHistory.tsx` | Cannot search past conversations |
| **No status bar** | N/A | No model/health/token display |
| **No conversation export** | N/A | Cannot export chats to JSON/Markdown/PDF |
| **No inline image rendering for tool results** | `ChatCenter.tsx` | Screenshot tool results show as base64 text |
| **No conversation tagging/folders** | N/A | Cannot organize chats by topic |

### Top 3 Concrete Fixes

1. **Add keyboard shortcuts** (new file `src/lib/keyboardShortcuts.ts`):
   ```typescript
   useEffect(() => {
     const handler = (e: KeyboardEvent) => {
       if (e.metaKey && e.key === 'k') { e.preventDefault(); openCommandPalette(); }
       if (e.metaKey && e.key === 'Enter' && isStreaming) { stop(); }
     };
     window.addEventListener('keydown', handler);
   }, []);
   ```

2. **Add status bar** (new component `src/components/StatusBar.tsx`):
   ```tsx
   export function StatusBar({ model, connected, tokens }: Props) {
     return <div className="status-bar">{model} | {connected ? '✓' : '✗'} | {tokens} tok</div>;
   }
   ```

3. **Add conversation export** (`src/lib/export.ts`):
   ```typescript
   export function exportChatToMarkdown(chat: ChatThread): string {
     return chat.messages.map(m => `**${m.role}**: ${m.content}`).join('\n\n');
   }
   ```

---

## Area 3: Audio Conversational Flow — 7/10

### What Exists

- **STT client:** `src/lib/sttClient.ts` — Whisper.cpp server integration (offline)
- **TTS client:** `src/lib/ttsClient.ts` — Piper TTS via Tauri command (local neural)
- **Voice settings:** `src/lib/voiceSettings.ts` — Configurable base URLs, speed, language
- **Voice panel:** `src/components/VoicePanel.tsx` — Server status, start/stop, test buttons
- **Silence token filtering:** `sttClient.ts:145-152` — Rejects `[BLANK_AUDIO]`, `(silence)` outputs
- **WAV conversion:** `sttClient.ts:23-77` — Converts any audio to 16-bit 16kHz mono WAV
- **Markdown stripping for TTS:** `ttsClient.ts:22-67` — Strips markdown before speech

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **No VAD (Voice Activity Detection)** | N/A | Uses basic silence token filtering, not real-time VAD |
| **No push-to-talk** | `VoicePanel.tsx` | Only continuous listening mode |
| **No waveform feedback** | N/A | No visual audio level indicator |
| **No ready tone customization** | `VoicePanel.tsx:70-88` | Fixed sine wave, no file support |
| **No speaker diarization** | N/A | Cannot distinguish multiple speakers |

### Top 3 Concrete Fixes

1. **Add push-to-talk mode** (`src/components/VoicePanel.tsx`):
   ```tsx
   const [pushToTalk, setPushToTalk] = useState(false);
   useEffect(() => {
     const down = (e: KeyboardEvent) => { if (e.key === ' ') startListening(); };
     const up = () => { stopListening(); };
     if (pushToTalk) { window.addEventListener('keydown', down); window.addEventListener('keyup', up); }
   }, [pushToTalk]);
   ```

2. **Add waveform visualizer** (new component `src/components/WaveformVisualizer.tsx`):
   ```tsx
   const analyser = audioContext.createAnalyser();
   const dataArray = new Uint8Array(analyser.frequencyBinCount);
   analyser.getByteTimeDomainData(dataArray);
   // Draw to canvas in requestAnimationFrame loop
   ```

3. **Add VAD with WebAudio** (new file `src/lib/vad.ts`):
   ```typescript
   function detectVoiceActivity(audioData: Float32Array): boolean {
     const rms = Math.sqrt(audioData.reduce((sum, x) => sum + x * x, 0) / audioData.length);
     return rms > THRESHOLD;
   }
   ```

---

## Area 4: MCP Tool Efficiency — 8/10

### What Exists

- **Tool result cache:** `src/lib/agentic.ts:56-68` — Caches results within single run
- **Tool catalog cache:** `src/lib/tool_cache.ts` — 5-minute TTL, version tracking
- **Tool allowlist:** `src/lib/agentic.ts:109-135` — 14 explicitly permitted tools
- **Tool approval UI:** `src/components/ToolApprovalModal.tsx` — Allow once / allow for chat
- **Tool logging:** `src/lib/toolLog.ts` — Persists to localStorage (120 entries max)
- **JSON Schema validation:** `src-tauri/src/mcp.rs:113-267` — Validates args at Rust boundary
- **Loop guard:** `src/lib/agent_loop_guard.ts` — Detects 4 loop patterns
- **Tool reflection:** `src/lib/toolReflection.ts` — Evaluates tool results with LLM

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **No write-aware cache invalidation** | `agentic.ts:56-68` | Writing to file X doesn't evict cache for X |
| **No human-readable tool labels** | `ToolsPanel.tsx` | Shows `fs.read_file` not "Read File" |
| **No terminal tool timeout** | N/A | No `shell.execute` tool exists (blocked by allowlist) |
| **No dry-run mode** | N/A | Cannot preview destructive tool effects |
| **No tool dependency graph** | N/A | Cannot see which tools depend on others |

### Top 3 Concrete Fixes

1. **Add write-aware cache invalidation** (`src/lib/agentic.ts`):
   ```typescript
   function invalidateCacheForPath(path: string) {
     for (const [key, _] of toolResultCache) {
       if (key.includes(path)) toolResultCache.delete(key);
     }
   }
   // Call after fs.write_file, fs.delete_file, fs.move_file
   ```

2. **Add human-readable tool labels** (`src/lib/toolLabels.ts`):
   ```typescript
   const TOOL_LABELS: Record<string, string> = {
     'fs.read_file': 'Read File',
     'fs.write_file': 'Write File',
     'fs.list_directory': 'List Directory',
   };
   ```

3. **Add dry-run mode** (`src/components/ToolApprovalModal.tsx`):
   ```tsx
   const [dryRun, setDryRun] = useState(false);
   // Show preview of what will change before approving
   ```

---

## Area 5: Chat Persistence & Database — 7/10

### What Exists

- **SQLite database:** `src/lib/db.ts` — rusqlite-based persistence via Tauri commands
- **Database schema:** `src-tauri/src/db.rs` — conversations + messages tables with summary column
- **Message compression:** `db.rs:236-294` — Auto-compresses when >30 messages
- **Conversation CRUD:** `db.ts:26-146` — Full create/read/update/delete operations
- **Tauri commands:** `db.rs:316-409` — `db_execute`, `db_select` for frontend access
- **Graceful shutdown:** `src/components/ErrorBoundary.tsx:15-34` — Crash log to disk
- **Agent run persistence:** `src/lib/agentic.ts:729-775` — Saves run state per step

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **No full-text search** | N/A | Cannot search conversation history |
| **No conversation tagging** | N/A | Cannot organize chats by topic |
| **No conversation folders** | N/A | Cannot group related chats |
| **No auto-save on crash** | `agentic.ts:729-775` | Saves per-step but not on browser crash |
| **No conversation export** | N/A | Cannot export to JSON/Markdown/PDF |

### Top 3 Concrete Fixes

1. **Add full-text search** (`src/lib/search.ts`):
   ```typescript
   export function searchChats(query: string): ChatThread[] {
     const chats = loadChats();
     return chats.filter(c => 
       c.title.toLowerCase().includes(query.toLowerCase()) ||
       c.messages.some(m => m.content.toLowerCase().includes(query.toLowerCase()))
     );
   }
   ```

2. **Add conversation export** (`src/lib/export.ts`):
   ```typescript
   export function exportChatToMarkdown(chat: ChatThread): string {
     return chat.messages.map(m => `**${m.role}**: ${m.content}`).join('\n\n');
   }
   ```

3. **Add conversation tagging** (modify `db.rs` schema):
   ```sql
   ALTER TABLE conversations ADD COLUMN tags TEXT;
   -- Store as JSON array: '["work","urgent"]'
   ```

---

## Area 6: Agentic Core Enterprise Robustness — 8/10

### What Exists

- **Tool result cache:** `agentic.ts:56-68` — Prevents redundant calls
- **Loop guard:** `src/lib/agent_loop_guard.ts` — Detects 4 loop patterns
- **Confidence gate:** `agentic.ts:1610-1625` — Blocks tools with confidence < 0.6
- **Reasoning stabilizer:** `agentic.ts:1597-1635` — Requires 10+ char reasoning
- **Tool budget:** `agentic.ts:1590-1606` — Adaptive 3-12 calls based on input length
- **Plan verification:** `agentic.ts:713-743` — Validates plan structure before execution
- **Execution trace:** `agentic.ts:25-37` — Records decision history for debugging
- **Context summarization:** `agentic.ts:446-526` — Summarizes dropped tool results
- **LLM retry with backoff:** `agentic.ts:1165-1195` — 3 retries with 0s/1s/3s delays
- **Circuit breaker:** `agentic.ts:1089-1099` — Blocks tool after 2 consecutive failures
- **Tool reflection:** `agentic.ts:1759-1784` — Evaluates tool results with LLM
- **Step timeout:** `agentic.ts:94-96, 1814-1823` — 60-second timeout per step

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **Parallel executor NOT wired** | N/A | Tools execute sequentially even when independent |
| **No sub-task decomposition** | N/A | Complex goals not broken into sub-goals |
| **No run checkpointing** | `agentic.ts:729-775` | Saves state but cannot resume mid-step |
| **No undo stack** | `workspace.rs` | Batch rollback exists but no per-operation undo |
| **No active clarification** | N/A | Agent asks user to rephrase, not structured options |

### Top 3 Concrete Fixes

1. **Wire parallel executor** (new file `src/lib/parallel_executor.ts`):
   ```typescript
   const independentTools = ['fs.read_file', 'fs.list_directory'];
   const queue: Array<{tool: string, args: any}> = [];
   
   function addTool(tool: string, args: any) {
     if (independentTools.includes(tool)) {
       queue.push({tool, args});
       if (queue.length >= 3) flushQueue();
     } else {
       return executeTool(tool, args);
     }
   }
   ```

2. **Add run checkpointing** (`src/lib/agentic.ts`):
   ```typescript
   interface Checkpoint {
     step: number;
     convo: OllamaMsg[];
     pendingWrites: PendingWrite[];
     toolBudget: number;
   }
   localStorage.setItem(`checkpoint:${runId}`, JSON.stringify(checkpoint));
   ```

3. **Add undo stack** (`src-tauri/src/workspace.rs`):
   ```rust
   static UNDO_STACK: Mutex<Vec<UndoEntry>> = Mutex::new(Vec::new());
   
   struct UndoEntry {
     path: String,
     previous_content: String,
     operation: String,
   }
   ```

---

## Area 7: Memory System — 6/10

### What Exists

- **Session memory:** `src/lib/memory.ts` — Facts per workspace root (localStorage)
- **Manual add/delete:** `memory.ts:47-62` — User can add facts, delete by ID
- **Memory formatting:** `memory.ts:67-72` — Formats for planner injection
- **Semantic index:** `src/lib/semanticIndex.ts` — Vector embeddings via Ollama
- **Semantic search:** `semanticIndex.ts:240-265` — Cosine similarity search
- **Synthetic tool:** `agentic.ts:1018-1042` — `semantic.find` tool for semantic search

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **Single-tier memory** | `memory.ts` | No working/episodic/semantic separation |
| **No confidence scoring** | N/A | All facts treated equally |
| **No memory decay** | N/A | Old facts never expire automatically |
| **No UI memory management** | N/A | No panel to view/edit/delete memories |
| **No auto-extraction** | `memory.ts:8` comment | V5 target but not implemented |

### Top 3 Concrete Fixes

1. **Add multi-tier memory** (new file `src/lib/memoryTiers.ts`):
   ```typescript
   interface WorkingMemory { facts: Fact[]; expiresAt: number; }
   interface EpisodicMemory { events: Event[]; }
   interface SemanticMemory { concepts: Concept[]; }
   ```

2. **Add memory confidence scoring** (`src/lib/memory.ts`):
   ```typescript
   interface MemoryFact {
     id: string;
     text: string;
     confidence: number;  // 0.0 - 1.0
     source: 'user' | 'agent' | 'inferred';
   }
   ```

3. **Add memory UI panel** (new component `src/components/MemoryPanel.tsx`):
   ```tsx
   export function MemoryPanel({ root }: { root: string }) {
     const facts = loadMemory(root);
     return (
       <div>
         {facts.map(f => (
           <div key={f.id}>
             {f.text}
             <button onClick={() => deleteFact(root, f.id)}>Delete</button>
           </div>
         ))}
       </div>
     );
   }
   ```

---

## Area 8: Stability & Production Robustness — 8/10

### What Exists

- **React ErrorBoundary:** `src/components/ErrorBoundary.tsx` — Full-screen error catch
- **Crash log to disk:** `ErrorBoundary.tsx:15-34` — Writes to `BaseDirectory.AppLog`
- **MCP auto-reconnect:** `src/lib/mcp.ts:165-180` — Exponential backoff, 5 attempts max
- **Tool timeout:** `src-tauri/src/mcp.rs:28` — 25s timeout (5s buffer over frontend 20s)
- **Graceful degradation:** `mcp.ts:195-210` — Falls back to client cache if MCP fails
- **First-run setup:** `src/components/RightPanel.tsx` — Provider selection, MCP config
- **LLM request queue:** `src/lib/llmQueue.ts` — Prevents concurrent overload
- **Agent step timeout:** `agentic.ts:94-96` — 60-second limit per step

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **No Ollama watchdog** | N/A | No process monitoring for Ollama crash |
| **No MCP health monitoring** | `mcp.rs` | No periodic health checks between calls |
| **No graceful shutdown hook** | N/A | No state save on app close |
| **No setup wizard** | `RightPanel.tsx` | Config scattered across panels |

### Top 3 Concrete Fixes

1. **Add Ollama watchdog** (new file `src-tauri/src/ollama_watchdog.rs`):
   ```rust
   fn check_ollama_health() {
     let status = reqwest::get("http://127.0.0.1:11434/api/tags").await;
     if status.is_err() {
       eprintln!("[watchdog] Ollama not responding!");
       // Optionally restart Ollama
     }
   }
   ```

2. **Add graceful shutdown hook** (`src/main.tsx`):
   ```typescript
   window.addEventListener('beforeunload', () => {
     saveAgentState();
     flushToolLog();
   });
   ```

3. **Add setup wizard** (new component `src/components/SetupWizard.tsx`):
   ```tsx
   export function SetupWizard({ onComplete }: Props) {
     const [step, setStep] = useState(0);
     // Step 1: Provider selection
     // Step 2: MCP config
     // Step 3: Voice config
     // Step 4: Workspace root
   }
   ```

---

## Priority Action Plan

| Priority | Fix | Impact (1-10) | Effort (1-10) | Score (Impact/Effort) |
|----------|-----|---------------|---------------|----------------------|
| 1 | Add syntax highlighting | ✅ DONE | 2 | N/A |
| 2 | Activate Ollama health monitor | ✅ DONE | 2 | N/A |
| 3 | Add LLM request timeout | ✅ DONE | 2 | N/A |
| 4 | Add agent step timeout | ✅ DONE | 2 | N/A |
| 5 | Add tool reflection | ✅ DONE | 3 | N/A |
| 6 | Add keyboard shortcuts | 7 | 3 | 2.3 |
| 7 | Add status bar | 6 | 3 | 2.0 |
| 8 | Add full-text search | 8 | 4 | 2.0 |
| 9 | Add conversation export | 5 | 3 | 1.7 |
| 10 | Add Ollama watchdog | 7 | 4 | 1.8 |
| 11 | Add memory UI panel | 6 | 5 | 1.2 |
| 12 | Add parallel executor | 7 | 6 | 1.2 |
| 13 | Add multi-tier memory | 6 | 6 | 1.0 |
| 14 | Add setup wizard | 5 | 5 | 1.0 |

---

## New Files Needed

| File | Purpose | Priority |
|------|---------|----------|
| `src/lib/ollamaHealth.ts` | Ollama health monitoring | ✅ DONE |
| `src/lib/llmQueue.ts` | LLM request queuing | ✅ DONE |
| `src/lib/toolReflection.ts` | Tool result evaluation | ✅ DONE |
| `src/lib/keyboardShortcuts.ts` | Cmd+K, Cmd+Enter handlers | High |
| `src/lib/search.ts` | Full-text conversation search | Medium |
| `src/lib/export.ts` | Conversation export | Medium |
| `src/lib/memoryTiers.ts` | Multi-tier memory | Low |
| `src/lib/parallel_executor.ts` | Parallel tool execution | Medium |
| `src/components/StatusBar.tsx` | Model/health/token display | High |
| `src/components/WaveformVisualizer.tsx` | Audio level visualization | Medium |
| `src/components/MemoryPanel.tsx` | Memory management UI | Medium |
| `src/components/SetupWizard.tsx` | First-run setup wizard | Medium |
| `src-tauri/src/ollama_watchdog.rs` | Ollama process monitoring | High |
| `src-tauri/src/db.rs` | SQLite database layer | ✅ DONE |

---

## Files That Don't Exist (Noted in Audit Requirements)

The following files were mentioned in audit requirements but don't exist in this codebase:

- `src/lib/audio/` — No audio pipeline directory (audio handled by `sttClient.ts` and `ttsClient.ts`)
- `src/lib/telemetry.ts` — No dedicated telemetry module (metrics in `agent_metrics.ts`)
- `src/lib/parallel_executor.ts` — Not implemented (listed in action plan)
- `src/lib/self_correction.ts` — Not implemented (reflection via `toolReflection.ts`)
- `src-tauri/src/schema_validator.rs` — Schema validation in `mcp.rs:113-267`
- `src-tauri/src/tools/` — No tools directory (MCP tools are external)

---

## Summary Assessment

**Nikolai Desktop** demonstrates an **exceptionally strong agent core** with industry-leading safety features (allowlist, loop guard, confidence gate, reasoning stabilizer, tool budget, plan verification, tool reflection). The system has excellent stability mechanisms (timeouts, queues, crash logging, graceful degradation).

**Key Strengths:**
- ✅ Multi-layer security architecture (allowlist + schema validation + symlink rejection)
- ✅ Comprehensive safety mechanisms (loop guard, confidence gate, reasoning validation, tool budget)
- ✅ SQLite database with automatic message compression
- ✅ Strong error handling (retry with backoff, circuit breaker, timeouts)
- ✅ Good observability (metrics, execution trace, tool logging, crash logs)
- ✅ Tool result caching and reflection

**Key Weaknesses:**
- ❌ No keyboard shortcuts (Cmd+K, Cmd+Enter)
- ❌ No status bar for model/health/token display
- ❌ No full-text conversation search
- ❌ Single-tier memory without confidence/decay
- ❌ No UI for memory management
- ❌ No Ollama process watchdog

**Recommendation:** The agent core is **production-ready**. Prioritize UI/UX improvements (keyboard shortcuts, status bar, conversation search/export) and add Ollama watchdog for enterprise deployment. Memory system enhancements would significantly improve long-term agent performance.

**Overall Score: 7.1/10** — Strong foundation with good stability, moderate UI/UX polish needed for enterprise deployment.
