# Nikolai Desktop Enterprise Audit

**Date:** March 2026  
**Version:** 0.1.1  
**Auditor:** AI Architecture Analysis  
**Scope:** Full-stack Tauri + React desktop AI assistant

---

## Score Summary Table

| Area | Score | Top Gap |
|------|-------|---------|
| 1. Ollama Integration | 7/10 | No VRAM request queuing, no per-model context windows |
| 2. UI/UX Enterprise Quality | 5/10 | No syntax highlighting, no keyboard shortcuts, no status bar |
| 3. Audio Conversational Flow | 7/10 | No VAD (basic RMS), no push-to-talk, no waveform feedback |
| 4. MCP Tool Efficiency | 8/10 | No write-aware cache invalidation, no dry-run mode |
| 5. Chat Persistence & Database | 7/10 | SQLite implemented but no full-text search, no tagging |
| 6. Agentic Core Enterprise Robustness | 8/10 | No parallel executor wiring, no sub-task decomposition |
| 7. Memory System | 6/10 | Single-tier memory, no confidence/decay, no UI management |
| 8. Stability & Production Robustness | 7/10 | No Ollama watchdog, no graceful shutdown hook |

**Overall Score: 6.9/10** — Strong agent core and security, moderate UI/UX and persistence

---

## Area 1: Ollama Integration — 7/10

### What Exists

- **Model fallback chain:** `src/lib/ollamaHealth.ts:25-28` — Chain: `qwen2.5:14b` → `qwen2.5:7b` → `llama3.2:3b` → `phi3:mini`
- **Health monitoring:** `src/lib/ollamaHealth.ts:33-68` — Checks `/api/tags` every 30 seconds, 3-strike failure detection
- **Auto-reconnect:** `src/lib/mcp.ts:165-180` — MCP auto-reconnect with exponential backoff (5 attempts max)
- **Streaming with abort:** `src/lib/ollamaStream.ts:75-95` — AbortSignal support, Tauri event-based streaming
- **Graceful disconnect handling:** `src/lib/ollamaStream.ts:82-88` — Cleanup on abort, error event listeners

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **No VRAM request queuing** | N/A | Multiple concurrent requests can overflow VRAM |
| **No per-model context window** | `agentic.ts:103-104` | Fixed `MAX_CONTEXT_CHARS = 10,000` for all models |
| **Health monitor not started automatically** | `src/main.tsx` | Must be manually started, not in startup sequence |
| **No model capability detection** | `ollamaHealth.ts:70-85` | Doesn't check if model supports vision, tools, etc. |

### Top 3 Concrete Fixes

1. **Add model fallback chain activation** (`src/main.tsx`):
   ```typescript
   import { ollamaHealth } from "./lib/ollamaHealth";
   ollamaHealth.start(); // Start health monitoring on app startup
   ```

2. **Add per-model context windows** (`src/lib/ollamaModels.ts`):
   ```typescript
   const CONTEXT_WINDOWS: Record<string, number> = {
     'qwen2.5:7b': 32768,
     'llama3:8b': 8192,
     'mistral:7b': 32768,
   };
   ```

3. **Add VRAM request queue** (new file `src/lib/ollamaQueue.ts`):
   ```typescript
   const queue: Array<() => Promise<any>> = [];
   let processing = false;
   
   async function processQueue() {
     if (processing || queue.length === 0) return;
     processing = true;
     while (queue.length > 0) {
       await queue.shift()!();
     }
     processing = false;
   }
   ```

---

## Area 2: UI/UX Enterprise Quality — 5/10

### What Exists

- **React Markdown rendering:** `ChatCenter.tsx:3-4` — Uses `react-markdown` + `remark-gfm`
- **Error boundary:** `ErrorBoundary.tsx` — Full-screen error catch with crash log to disk
- **Resizable panels:** `ResizableShell.tsx` — Drag-to-resize left/right panels
- **Tool approval modal:** `ToolApprovalModal.tsx` — Allow once / allow for chat / deny
- **PDF text extraction:** `ChatCenter.tsx:88-115` — Lazy pdfjs-dist import for PDF drops
- **Image attachment support:** `ChatCenter.tsx:63-85` — Drag-drop images, base64 encoding

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **No syntax highlighting** | `ChatCenter.tsx:3-4` | Code blocks render as plain text |
| **No conversation search** | `ChatHistory.tsx` | Cannot search past conversations |
| **No keyboard shortcuts** | N/A | No Cmd+K, Cmd+Enter, Escape handlers |
| **No status bar** | N/A | No model/health/token display |
| **No conversation export** | N/A | Cannot export chats to JSON/Markdown |
| **No inline image rendering for tool results** | `ChatCenter.tsx` | Screenshot tool results show as base64 text |

### Top 3 Concrete Fixes

1. **Add syntax highlighting** (`ChatCenter.tsx`):
   ```bash
   npm install react-syntax-highlighter
   ```
   ```tsx
   import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
   // Wrap code blocks in ChatCenter render
   ```

2. **Add keyboard shortcuts** (new file `src/lib/keyboardShortcuts.ts`):
   ```typescript
   useEffect(() => {
     const handler = (e: KeyboardEvent) => {
       if (e.metaKey && e.key === 'k') { e.preventDefault(); openCommandPalette(); }
       if (e.metaKey && e.key === 'Enter' && isStreaming) { stop(); }
     };
     window.addEventListener('keydown', handler);
   }, []);
   ```

3. **Add status bar** (new component `src/components/StatusBar.tsx`):
   ```tsx
   export function StatusBar({ model, connected, tokens }: Props) {
     return <div className="status-bar">{model} | {connected ? '✓' : '✗'} | {tokens} tok</div>;
   }
   ```

---

## Area 3: Audio Conversational Flow — 7/10

### What Exists

- **STT client:** `src/lib/sttClient.ts` — Whisper.cpp server integration
- **TTS client:** `src/lib/ttsClient.ts` — Piper TTS via Tauri command
- **Voice settings:** `src/lib/voiceSettings.ts` — Configurable base URLs, speed, language
- **Voice panel:** `src/components/VoicePanel.tsx` — Server status, start/stop, test buttons
- **Silence token filtering:** `sttClient.ts:145-152` — Rejects `[BLANK_AUDIO]`, `(silence)` outputs
- **WAV conversion:** `sttClient.ts:23-77` — Converts any audio to 16kHz mono WAV
- **Markdown stripping for TTS:** `ttsClient.ts:22-67` — Strips markdown before speech

### What Is Missing

| Gap | File:Line | Impact |
|-----|-----------|--------|
| **VAD is basic RMS only** | N/A | No WebAudio-based voice activity detection |
| **No offline STT fallback** | `sttClient.ts:90-120` | Web Speech API not implemented as fallback |
| **No push-to-talk** | `VoicePanel.tsx` | Only continuous listening mode |
| **No waveform feedback** | N/A | No visual audio level indicator |
| **No ready tone customization** | `VoicePanel.tsx:70-88` | Fixed sine wave, no file support |

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

- **Tool result cache:** `agentic.ts:56-68` — Caches results within single run
- **Tool catalog cache:** `src/lib/tool_cache.ts` — 5-minute TTL, version tracking
- **Tool allowlist:** `agentic.ts:109-135` — 14 explicitly permitted tools
- **Tool approval UI:** `src/components/ToolApprovalModal.tsx` — Allow once / allow for chat
- **Tool logging:** `src/lib/toolLog.ts` — Persists to localStorage (120 entries max)
- **JSON Schema validation:** `src-tauri/src/mcp.rs:113-267` — Validates args at Rust boundary
- **Loop guard:** `src/lib/agent_loop_guard.ts` — Detects 4 loop patterns

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

- **SQLite database:** `src/lib/db.ts` — rusqlite-based persistence
- **Database schema:** `src-tauri/src/db.rs` — conversations + messages tables with summary column
- **Message compression:** `db.rs:236-294` — Auto-compresses when >30 messages
- **Conversation CRUD:** `db.ts:26-146` — Full create/read/update/delete operations
- **Tauri commands:** `db.rs:316-409` — `db_execute`, `db_select` for frontend access
- **Graceful shutdown:** `src/components/ErrorBoundary.tsx:15-34` — Crash log to disk

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

## Area 8: Stability & Production Robustness — 7/10

### What Exists

- **React ErrorBoundary:** `src/components/ErrorBoundary.tsx` — Full-screen error catch
- **Crash log to disk:** `ErrorBoundary.tsx:15-34` — Writes to `BaseDirectory.AppLog`
- **MCP auto-reconnect:** `src/lib/mcp.ts:165-180` — Exponential backoff, 5 attempts max
- **Tool timeout:** `src-tauri/src/mcp.rs:28` — 25s timeout (5s buffer over frontend 20s)
- **Graceful degradation:** `mcp.ts:195-210` — Falls back to client cache if MCP fails
- **First-run setup:** `src/components/RightPanel.tsx` — Provider selection, MCP config

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
| 1 | Add syntax highlighting | 8 | 2 | 4.0 |
| 2 | Add model fallback chain activation | 9 | 3 | 3.0 |
| 3 | Add Ollama health monitor start | 8 | 2 | 4.0 |
| 4 | Add keyboard shortcuts | 7 | 3 | 2.3 |
| 5 | Add TTS markdown stripping | 6 | 2 | 3.0 |
| 6 | Add full-text search | 8 | 4 | 2.0 |
| 7 | Add parallel executor | 7 | 6 | 1.2 |
| 8 | Add memory UI panel | 6 | 5 | 1.2 |
| 9 | Add Ollama watchdog | 7 | 4 | 1.8 |
| 10 | Add conversation export | 5 | 3 | 1.7 |

---

## New Files Needed

| File | Purpose | Priority |
|------|---------|----------|
| `src/lib/ollamaHealth.ts` | Ollama health monitoring | **DONE** |
| `src/lib/keyboardShortcuts.ts` | Cmd+K, Cmd+Enter handlers | High |
| `src/lib/parallel_executor.ts` | Parallel tool execution | Medium |
| `src/lib/search.ts` | Full-text conversation search | Medium |
| `src/lib/export.ts` | Conversation export | Medium |
| `src/lib/memoryTiers.ts` | Multi-tier memory | Low |
| `src/components/StatusBar.tsx` | Model/health/token display | High |
| `src/components/WaveformVisualizer.tsx` | Audio level visualization | Medium |
| `src/components/MemoryPanel.tsx` | Memory management UI | Medium |
| `src/components/SetupWizard.tsx` | First-run setup wizard | Medium |
| `src-tauri/src/ollama_watchdog.rs` | Ollama process monitoring | High |
| `src-tauri/src/db.rs` | SQLite database layer | **DONE** |

---

## Summary Assessment

**Nikolai Desktop** demonstrates an **exceptionally strong agent core** with industry-leading safety features (allowlist, loop guard, confidence gate, reasoning stabilizer, tool budget, plan verification). However, **UI/UX and persistence layers lag** behind enterprise expectations.

**Key Strengths:**
- Multi-layer security architecture (allowlist + schema validation + symlink rejection)
- Comprehensive safety mechanisms (loop guard, confidence gate, reasoning validation)
- Strong error handling (retry with backoff, circuit breaker, graceful degradation)
- Good observability (metrics, execution trace, tool logging)
- SQLite database with automatic message compression

**Key Weaknesses:**
- No syntax highlighting for code blocks
- No keyboard shortcuts or command palette
- No Ollama health monitoring activation
- Single-tier memory without confidence/decay
- No UI for memory management

**Recommendation:** Prioritize UI/UX improvements (syntax highlighting, keyboard shortcuts, status bar) and activate Ollama health monitoring for production readiness. Agent core is production-ready.

**Overall Score: 6.9/10** — Strong foundation, moderate polish needed for enterprise deployment.
