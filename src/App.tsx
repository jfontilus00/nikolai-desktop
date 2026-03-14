import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatThread, Message, ProviderConfig } from "./types";
import { uid } from "./lib/id";
import {
  loadLayout,
  loadProvider,
  saveProvider,
} from "./lib/storage";
import { useChats } from "./hooks/useChats";
import ResizableShell from "./components/ResizableShell";
import ChatHistory from "./components/ChatHistory";
import ChatCenter from "./components/ChatCenter";
import RightPanel from "./components/RightPanel";
import ToolApprovalModal from "./components/ToolApprovalModal";
import ErrorBoundary from "./components/ErrorBoundary";
import TestRecorder from "./components/TestRecorder";
import { ollamaStreamChat, StreamTimeoutError } from "./lib/ollamaStream";
import { streamChatWithProvider } from "./lib/providerStream";
import { agenticStreamChat } from "./lib/agentic";
import { parseToolCommand } from "./lib/toolCmd";
import { mcpCallTool, getCachedTools } from "./lib/mcp"; // ← Priority 5: getCachedTools replaces mcpListTools for /tools
import { appendToolLog } from "./lib/toolLog";
import { formatToolResult } from "./lib/toolResult";
import { withTimeout } from "./lib/timeout";

// Voice
import { loadVoiceSettings } from "./lib/voiceSettings";
import { logUsage } from "./lib/usageLog";
import { estimateTokensFromText } from "./lib/tokenEstimator";
import { ttsSpeak, ttsSpeakQueued } from "./lib/ttsClient";

// ── Sentence boundary detection ────────────────────────────────────────────
// Handles abbreviations, decimals, URLs, ellipsis, and initials
// without relying on a single naive regex.

const ABBREVS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs",
  "etc", "eg", "ie", "approx", "dept", "est", "govt", "corp",
  "inc", "ltd", "co", "fig", "no", "vol", "pp", "sec",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
  "oct", "nov", "dec",
]);

function splitSentences(text: string): string[] {
  const results: string[] = [];
  let buf = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;

    // Only evaluate potential sentence ends at . ! ?
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    // Ellipsis: collect all consecutive dots
    if (ch === ".") {
      let dots = 1;
      while (i + dots < text.length && text[i + dots] === ".") {
        buf += text[i + dots];
        dots++;
        i++;
      }
      if (dots >= 2) continue; // ellipsis — not a sentence end
    }

    // Must be followed by whitespace or end of string to be a real boundary
    const next = text[i + 1];
    if (next && next !== " " && next !== "\n" && next !== "\r") continue;

    // Decimal numbers: digit before dot and digit would follow
    if (ch === "." && i >= 1 && /\d/.test(text[i - 1])) {
      const afterSpace = next === " " ? text[i + 2] : text[i + 1];
      if (afterSpace && /\d/.test(afterSpace)) continue;
    }

    // URL detection: if we're inside a URL, skip
    const beforeDot = buf.slice(-30).toLowerCase();
    if (/https?:\/\/\S*$/.test(beforeDot)) continue;
    if (/www\.\S*$/.test(beforeDot)) continue;

    // Abbreviation detection: word before dot is a known abbreviation
    if (ch === ".") {
      const wordMatch = buf.slice(0, -1).match(/([a-zA-Z]+)$/);
      if (wordMatch) {
        const word = wordMatch[1].toLowerCase();
        if (ABBREVS.has(word)) continue;
        // Single capital letter (initials): A. B. U.S.A. etc.
        if (/^[A-Z]$/.test(wordMatch[1])) continue;
      }
    }

    // This is a real sentence boundary
    const sentence = buf.trim();
    if (sentence.length > 0) {
      results.push(sentence);
      buf = "";
    }
  }

  // Remaining buffer (incomplete sentence, no terminal punctuation)
  const remaining = buf.trim();
  if (remaining.length > 0) {
    results.push(remaining);
  }

  return results;
}

/**
 * Returns true ONLY when the user message clearly requires
 * filesystem access or explicit tool use.
 *
 * TRUE (agent mode):   "read config.ts", "list files in src/", "fix the parseJSON function"
 * FALSE (chat mode):   "brainstorm ideas", "how does recursion work", "analyze my approach"
 */
function shouldUseAgentic(prompt: string): boolean {
  const t = prompt.toLowerCase().trim();

  // GATE 1 — Explicit filesystem operation on a named target
  const explicitFileOp = /\b(read|open|load|write|save|create|delete|remove|rename|move|copy)\s+(the\s+)?(file|folder|directory|dir|path|document|config|script|module)\b/i;
  if (explicitFileOp.test(t)) return true;

  // GATE 2 — Explicit listing or searching for files
  const explicitList = /\b(list|show|find|search|scan|grep)\s+(all\s+)?(files?|folders?|directories|\.ts|\.js|\.tsx|\.py|\.rs|\.json|\.md)\b/i;
  if (explicitList.test(t)) return true;

  // GATE 3 — Explicit open/read of codebase (NOT just "analyze" or "review")
  const explicitCodeRead = /\b(open|read|inspect)\s+(the\s+)?(code|codebase|repo|repository|source)\b/i;
  if (explicitCodeRead.test(t)) return true;

  // GATE 4 — Message contains a literal file path or file extension
  const hasFilePath = /[a-zA-Z0-9_\-\/\\]+\.(ts|js|tsx|jsx|rs|py|json|md|txt|toml|yaml|yml|css|html)\b/;
  if (hasFilePath.test(t)) return true;

  // GATE 5 — User explicitly requests tool/agent/command use
  const explicitToolRequest = /\b(use|call|run|execute)\s+(the\s+)?(tool|agent|command)\b/i;
  if (explicitToolRequest.test(t)) return true;

  // GATE 6 — Explicit write/edit on a named code artifact
  const explicitCodeWrite = /\b(write|add|edit|modify|update|refactor|fix|implement)\s+(the\s+|a\s+)?(function|class|component|method|implementation|module)\b/i;
  if (explicitCodeWrite.test(t)) return true;

  // Pure chat — brainstorming, questions, discussion → no tools
  return false;
}

function newChat(): ChatThread {
  const id = uid("chat");
  const now = Date.now();
  return { id, title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

export default function App() {
  const { chats, setChats, activeId, setActiveId, createChat: createChatDb, saveMessage, deleteChat: deleteChatDb, loading } = useChats();
  const chatsRef = useRef<ChatThread[]>(chats);
  useEffect(() => { chatsRef.current = chats; }, [chats]);

  const [leftCollapsed, setLeftCollapsed] = useState(() => loadLayout().leftCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(() => loadLayout().rightCollapsed);

  const [provider, setProviderState] = useState<ProviderConfig>(() => loadProvider());
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ── Priority 4: Agent status — ephemeral React state, never in message content
  const [agentStatus, setAgentStatus] = useState<string>("");

  // ── Per-tool timeouts ────────────────────────────────────────────────────
  // 20s global was too blunt. Long-running tools (exports, analysis, semantic
  // search) legitimately take 60–180s. FS reads/lists are fast — keep them tight.
  function getToolTimeout(toolName: string): number {
    // Slow tools — allow up to 3 minutes
    if (
      toolName.includes("project-brain") ||
      toolName.includes("export_docx") ||
      toolName.includes("export_pdf") ||
      toolName.includes("export_pptx") ||
      toolName.includes("export_xlsx") ||
      toolName.includes("export_") ||
      toolName.includes("render_") ||
      toolName === "semantic.find"
    ) return 180_000;

    // Medium tools — 60s
    if (
      toolName.includes("hub.") ||
      toolName.includes("analyze") ||
      toolName.includes("git.")
    ) return 60_000;

    // Fast FS tools — 20s (network drives can still be slow)
    return 20_000;
  }

  type StreamBuffer = {
    chatId: string;
    messageId: string;
    chunks: string[];
    rafId: number | null;
    pending: boolean;
    lastPersist: number;
  };

  const streamingBuffersRef = useRef<Map<string, StreamBuffer>>(new Map());

  const flushStreamingBuffer = useCallback(
    async (chatId: string, messageId: string, forcePersist: boolean = false) => {
      const buffers = streamingBuffersRef.current;
      const buf = buffers.get(messageId);
      if (!buf || !buf.pending || buf.chatId !== chatId) return;

      const content = buf.chunks.join("");
      buf.chunks = [];
      buf.pending = false;
      if (!content) return;

      const now = Date.now();
      const shouldPersist = forcePersist || now - buf.lastPersist > 500;

      // Update React state (synchronous)
      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          const msgs = c.messages.map((m) =>
            m.id === messageId ? { ...m, content: (m.content || "") + content } : m
          );
          return { ...c, updatedAt: Date.now(), messages: msgs };
        });
        return next;
      });

      // Persist to SQLite after state update (async)
      if (shouldPersist) {
        buf.lastPersist = now;
        // Get the complete message content from state
        const chat = chats.find(c => c.id === chatId);
        const message = chat?.messages.find(m => m.id === messageId);
        if (message?.content) {
          await saveMessage(chatId, message.role, message.content).catch(console.error);
        }
      }
    },
    [chats, saveMessage, setChats]
  );

  const scheduleFlush = useCallback(
    (chatId: string, messageId: string) => {
      const buffers = streamingBuffersRef.current;
      const buf = buffers.get(messageId);
      if (!buf || buf.rafId !== null) return;
      buf.rafId = requestAnimationFrame(() => {
        const b = buffers.get(messageId);
        if (b) { b.rafId = null; flushStreamingBuffer(chatId, messageId, false); }
      });
    },
    [flushStreamingBuffer]
  );

  const createStreamingTokenHandler = useCallback(
    (chatId: string, messageId: string) => {
      const buffers = streamingBuffersRef.current;
      const existing = buffers.get(messageId);
      if (existing && existing.rafId !== null) cancelAnimationFrame(existing.rafId);

      buffers.set(messageId, {
        chatId, messageId, chunks: [], rafId: null, pending: false, lastPersist: Date.now(),
      });

      return (t: string) => {
        const buf = buffers.get(messageId);
        if (!buf || buf.chatId !== chatId) return;
        buf.chunks.push(t);
        assistantTextRef.current += t;
        // Sentence streaming detection
        sentenceBufferRef.current += t;

        // Use improved sentence boundary detection
        const rawSentences = splitSentences(sentenceBufferRef.current);
        // Only take complete sentences (last item may be incomplete if no terminal punctuation)
        const sentences = rawSentences.length > 1
          ? rawSentences.slice(0, -1)   // all but last (last may be incomplete)
          : rawSentences[0]?.match(/[.!?]$/)  // or last if it ends with punctuation
            ? rawSentences
            : null;

        // Keep incomplete last fragment in buffer
        if (rawSentences.length > 1) {
          sentenceBufferRef.current = rawSentences[rawSentences.length - 1] ?? "";
        } else if (!rawSentences[0]?.match(/[.!?]$/)) {
          // whole buffer is one incomplete sentence — leave it
        } else {
          sentenceBufferRef.current = "";
        }

        if (sentences && sentences.length > 0) {
          for (const sentence of sentences) {
            const clean = sentence.trim();
            if (!clean) continue;

            if (!spokenSentencesRef.current.has(clean)) {
              spokenSentencesRef.current.add(clean);

              const vs = loadVoiceSettings();

              if (vs.autoSpeak && voiceSessionActiveRef.current) {
                ttsSpeakQueued(clean, vs).catch((e) => {
                  console.warn("[SENTENCE-TTS] failed:", e);
                });
              }
            }
          }
        }

        /* Early speech trigger — fires when the buffer grows long but punctuation hasn't arrived yet */
        // Threshold: 80 chars gives ~400ms first-word latency (ChatGPT-level instant feel)
        if (
          sentenceBufferRef.current.length > 80 &&
          sentenceBufferRef.current.length < 400 &&  // don't early-trigger a wall of text
          !/[.!?]/.test(sentenceBufferRef.current)   // only when NO punctuation (sentences handles those)
        ) {
          const early = sentenceBufferRef.current.trim();

          if (early && !spokenSentencesRef.current.has(early)) {

            const now = Date.now();

            if (now - lastEarlyTriggerRef.current > 800) {

              spokenSentencesRef.current.add(early);
              lastEarlyTriggerRef.current = now;

              const vs = loadVoiceSettings();

              if (vs.autoSpeak && voiceSessionActiveRef.current) {
                ttsSpeakQueued(early, vs).catch((e) => {
                  console.warn("[EARLY-SPEAK] failed:", e);
                });
                console.log(`[EARLY-SPEAK] triggered at ${early.length} chars: "${early.slice(0, 40)}..."`);
              }

              sentenceBufferRef.current = "";
            }
          }
        }

        buf.pending = true;
        scheduleFlush(chatId, messageId);
      };
    },
    [scheduleFlush]
  );

  const finalizeStreaming = useCallback(
    (chatId: string, messageId: string) => {
      const buffers = streamingBuffersRef.current;
      const buf = buffers.get(messageId);
      if (!buf || buf.chatId !== chatId) return;
      if (buf.rafId !== null) { cancelAnimationFrame(buf.rafId); buf.rafId = null; }
      flushStreamingBuffer(chatId, messageId, true);
      buffers.delete(messageId);
      // Flush remaining sentence — check BEFORE clearing the dedup set
      const remaining = sentenceBufferRef.current.trim();

      const vs = loadVoiceSettings();

      if (
        remaining &&
        !spokenSentencesRef.current.has(remaining) &&  // ← dedup check BEFORE clear
        vs.autoSpeak &&
        voiceSessionActiveRef.current
      ) {
        ttsSpeakQueued(remaining, vs).catch((e) => {
          console.warn("[FINAL-SPEAK] failed:", e);
        });
      }

      if (spokenSentencesRef.current.size > 0) {
        streamingSpokeSomethingRef.current = true;
      }

      // Clean up all streaming state — AFTER the remaining check
      sentenceBufferRef.current = "";
      spokenSentencesRef.current.clear();
      lastEarlyTriggerRef.current = 0;
    },
    [flushStreamingBuffer]
  );

  useEffect(() => {
    return () => {
      const buffers = streamingBuffersRef.current;
      if (buffers.size === 0) return;
      let currentChats = chatsRef.current;
      let modified = false;
      buffers.forEach((buf) => {
        if (buf.rafId !== null) cancelAnimationFrame(buf.rafId);
        if (buf.pending && buf.chunks.length > 0) {
          const content = buf.chunks.join("");
          currentChats = currentChats.map((c) => {
            if (c.id !== buf.chatId) return c;
            const msgs = c.messages.map((m) =>
              m.id === buf.messageId ? { ...m, content: (m.content || "") + content } : m
            );
            return { ...c, updatedAt: Date.now(), messages: msgs };
          });
          modified = true;
        }
      });
      // Persist any remaining buffered content on unmount
      if (modified) {
        currentChats.forEach(async (chat) => {
          for (const msg of chat.messages) {
            if (msg.content) {
              await saveMessage(chat.id, msg.role, msg.content).catch(console.error);
            }
          }
        });
      }
      buffers.clear();
    };
  }, [saveMessage]);

  const toolApprovalResolveRef = useRef<((choice: "deny" | "once" | "chat") => void) | null>(null);
  const [toolApproval, setToolApproval] = useState<{ open: boolean; toolName: string; toolArgs: any }>({
    open: false, toolName: "", toolArgs: {},
  });
  // Persist per-session tool approvals — survives hot-reload / tab refresh.
  // Cleared when window closes (intentional — approvals shouldn't carry to new session).
  const [toolAllowInChat, setToolAllowInChat] = useState<Record<string, boolean>>(() => {
    try {
      const raw = sessionStorage.getItem("nikolai.tool.allow");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  const requestToolApproval = (toolName: string, toolArgs: any) =>
    new Promise<"deny" | "once" | "chat">((resolve) => {
      toolApprovalResolveRef.current = resolve;
      setToolApproval({ open: true, toolName, toolArgs });
    });

  const closeToolApproval = (choice: "deny" | "once" | "chat") => {
    setToolApproval((p) => ({ ...p, open: false }));
    const r = toolApprovalResolveRef.current;
    toolApprovalResolveRef.current = null;
    r?.(choice);
  };

  function normalizeWinPath(p: string) {
    let s = String(p || "").trim().replace(/^"(.*)"$/, "$1");
    // Strip Windows \\?\\ extended-length prefix added by Rust canonicalize()
    // Use startsWith to avoid regex escaping nightmares
    if (s.startsWith("\\\\?\\")) s = s.slice(4);
    // Also handle the forward-slash variant just in case it ever appears
    if (s.startsWith("//?/")) s = s.slice(4);
    return s.replace(/\\/g, "/");
  }

  // True for bare filenames like "foo.txt" or "subdir/foo.txt".
  // False for absolute paths like "C:/..." or "/usr/..." or "//UNC/..."
  function isRelativePath(p: string): boolean {
    if (!p) return false;
    const n = p.replace(/\\/g, "/");
    if (/^[a-zA-Z]:/.test(n)) return false; // Windows absolute: C:/...
    if (n.startsWith("/"))     return false; // Unix or UNC: /... or //...
    return true;
  }

  // NEW: for Windows, enforce paths stay under workspace root (case-insensitive)
  function toRelUnderRoot(absPath: string, absRoot: string): string | null {
    const root = normalizeWinPath(absRoot).replace(/\/+$/, "");
    const p    = normalizeWinPath(absPath);

    const rootLower = root.toLowerCase();
    const pathLower = p.toLowerCase();

    if (pathLower === rootLower) return "";
    if (pathLower.startsWith(rootLower + "/")) {
      return p.slice(root.length + 1);
    }
    return null;
  }

  // NEW: enforce fs.* absolute paths must be under wsRoot (and normalize them)
  function enforceFsArgsUnderRoot(toolName: string, args: any, wsRoot?: string | null) {
    if (!wsRoot) return;
    if (!toolName.startsWith("fs.")) return;

    const root = normalizeWinPath(wsRoot).replace(/\/+$/, "");
    const a = args && typeof args === "object" ? args : {};

    for (const k of ["path", "src", "dst", "from", "to", "source", "destination", "oldPath", "newPath"]) {
      const v = (a as any)[k];
      if (typeof v !== "string" || !v.trim()) continue;

      const p = normalizeWinPath(v);

      // Relative is fine (it will be rooted by normalizeFsArgs)
      if (isRelativePath(p)) continue;

      // Absolute: must be under root
      const rel = toRelUnderRoot(p, root);
      if (rel === null) {
        throw new Error(
          `${toolName}: path outside workspace root (arg "${k}"). Use a RELATIVE path.\n` +
          `path: ${p}\nroot: ${root}`
        );
      }

      // Normalize absolute-under-root to a clean rooted absolute path
      (a as any)[k] = rel ? `${root}/${rel}` : root;
    }
  }

  // Resolve paths against workspace root. wsRoot must be passed in explicitly
  // because this function is called from both sync and async contexts.
  function normalizeFsArgs(_tool: string, a: any, wsRoot?: string | null) {
    const args = a && typeof a === "object" ? { ...a } : {};
    for (const k of ["path", "src", "dst", "from", "to", "source", "destination", "oldPath", "newPath"]) {
      if (typeof (args as any)[k] === "string") {
        let p = normalizeWinPath((args as any)[k]);
        // Relative path — prepend workspace root so MCP server accepts it
        if (wsRoot && isRelativePath(p)) {
          const root = normalizeWinPath(wsRoot).replace(/\/+$/, "");
          p = `${root}/${p}`;
        }
        (args as any)[k] = p;
      }
    }
    return args;
  }

  // Shared helper — fetches workspace root from Tauri once per tool call
  async function getWsRoot(): Promise<string | null> {
    try {
      const { invoke } = await import("@tauri-apps/api/tauri");
      const raw = await invoke<string | null>("ws_get_root");
      if (!raw) return null;
      // Strip Windows \\?\\ extended-length prefix (added by Rust canonicalize())
      // before using as workspace root — MCP server does not understand this prefix.
      if (raw.startsWith("\\\\?\\")) return raw.slice(4).replace(/\\/g, "/");
      if (raw.startsWith("//?/")) return raw.slice(4).replace(/\\/g, "/");
      return raw.replace(/\\/g, "/");
    } catch { return null; }
  }

  function validateToolArgs(tool: string, args: any): { ok: true } | { ok: false; error: string } {
    const a = args && typeof args === "object" ? args : {};
    const need = (k: string) => typeof (a as any)[k] === "string" && (a as any)[k].trim().length > 0;
    if (tool === "fs.read_file" && !need("path"))
      return { ok: false, error: 'fs.read_file requires args: { path: "..." }' };
    if (tool === "fs.list_directory" && !need("path"))
      return { ok: false, error: 'fs.list_directory requires args: { path: "..." }' };
    if (tool === "fs.search_files" && (!need("path") || !need("query")))
      return { ok: false, error: 'fs.search_files requires args: { path: "...", query: "..." }' };
    if (tool === "fs.write_file") {
      if (!need("path"))
        return { ok: false, error: 'fs.write_file requires args: { path: "...", content: "..." }' };
      if (typeof (a as any).content !== "string")
        return { ok: false, error: "fs.write_file requires args.content as a string" };
    }
    return { ok: true };
  }

  const executeToolWithApproval = async (name: string, args: any, signal?: AbortSignal) => {
    // Pre-flight: abort immediately if the run was cancelled before this call
    if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

    const wsRoot = await getWsRoot();
    const normalizedArgs = normalizeFsArgs(name, args, wsRoot);

    // NEW: block absolute paths outside root for fs.* tools
    enforceFsArgsUnderRoot(name, normalizedArgs, wsRoot);

    const v = validateToolArgs(name, normalizedArgs);
    if (!v.ok) throw new Error(`Tool args invalid: ${v.error}`);

    if (toolAllowInChat[`${activeId || "nochat"}::${name}`]) {
      return await withTimeout(mcpCallTool(name, normalizedArgs, signal), getToolTimeout(name), `Tool timeout: ${name}`, signal);
    }

    const choice = await requestToolApproval(name, normalizedArgs);
    if (choice === "deny") throw new Error("Tool denied by user");
    if (choice === "chat") {
      setToolAllowInChat((prev) => {
        const next = { ...prev, [`${activeId || "nochat"}::${name}`]: true };
        try { sessionStorage.setItem("nikolai.tool.allow", JSON.stringify(next)); } catch (e) { console.warn("[APP] sessionStorage write failed:", e); }
        return next;
      });
    }
    return await withTimeout(mcpCallTool(name, normalizedArgs, signal), getToolTimeout(name), `Tool timeout: ${name}`, signal);
  };

  const activeChat = useMemo(() => {
    const found = chats.find((c) => c.id === activeId);
    console.log("[APP] activeChat", { activeId, chatsLength: chats.length, found: !!found, messages: found?.messages?.length });
    return found || null;
  }, [chats, activeId]);

  // Thinking indicator: show when streaming but no content yet
  const isThinking = isStreaming && activeChat && activeChat.messages.length > 0 && !activeChat.messages[activeChat.messages.length - 1]?.content;

  const persist = (next: ChatThread[], nextActive?: string | null) => {
    setChats(next);
    if (typeof nextActive !== "undefined") {
      setActiveId(nextActive);
      localStorage.setItem('nikolai.activeChatId.v1', nextActive);
    }
  };

  const setProvider = (p: ProviderConfig) => {
    setProviderState(p);
    saveProvider(p);
  };

  const createChat = async () => {
    await createChatDb();
  };

  const deleteChat = async (id: string) => {
    const c = chats.find((c) => c.id === id);
    if (!confirm(`Delete "${c?.title || "this chat"}"? This cannot be undone.`)) return;
    await deleteChatDb(id);
  };

  const renameChat = async (id: string, title: string) => {
    setChats(chats.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)));
    // Note: SQLite doesn't have rename yet, title is stored in conversation
  };

  const selectChat = (id: string) => {
    setActiveId(id);
    localStorage.setItem('nikolai.activeChatId.v1', id);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setAgentStatus("");
  };

  const clearStatusForActiveChat = () => {
    setAgentStatus("");
    const chat = activeChat;
    if (!chat) return;
    // Clean up any legacy __STATUS__: messages from old saves
    setChats((prev) => {
      const next = prev.map((c) => {
        if (c.id !== chat.id) return c;
        const msgs = c.messages.map((m) => {
          if (m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("__STATUS__:")) {
            return { ...m, content: "" };
          }
          return m;
        });
        return { ...c, updatedAt: Date.now(), messages: msgs };
      });
      return next;
    });
  };

  // Guard against double-send (e.g. double-click, rapid Enter presses)
  const sendingRef = useRef(false);

  // Tracks last spoken text to avoid re-speaking the same message on re-render
  const lastSpokenRef = useRef<string>("");
  const streamingSpokeSomethingRef = useRef(false);
  const sentenceBufferRef = useRef("");
  const spokenSentencesRef = useRef<Set<string>>(new Set());
  const lastEarlyTriggerRef = useRef(0);
  const voiceSessionActiveRef = useRef<boolean>(false);

  // Accumulates assistant text during streaming
  const assistantTextRef = useRef<string>("");

  // Truncates to 40 chars — enough to distinguish chats in the sidebar.
  const autoTitleChat = useCallback((chatId: string, userText: string) => {
    setChats((prev) => {
      const chat = prev.find((c) => c.id === chatId);
      if (!chat || chat.title !== "New chat") return prev;
      const raw   = userText.trim().replace(/\n/g, " ");
      const title = raw.length > 40 ? raw.slice(0, 40) + "…" : raw;
      return prev.map((c) => c.id === chatId ? { ...c, title, updatedAt: Date.now() } : c);
    });
  }, []);

async function maybeAutoSpeakLastAssistant(chatId?: string) {
    if (streamingSpokeSomethingRef.current) {
      streamingSpokeSomethingRef.current = false;
      return;
    }
    try {
      const vs = loadVoiceSettings();
      console.log("[AUTO-SPEAK:1] triggered, autoSpeak=", vs?.autoSpeak);
      if (!vs.autoSpeak || !voiceSessionActiveRef.current) {
        return;
      }
      const all = chats;
      const id = chatId || activeId;
      const thread = all.find((c) => c.id === id) || all[0];
      const msg = thread?.messages
        ?.slice().reverse()
        .find((m) =>
          m.role === "assistant" &&
          (m.content || "").trim().length > 0 &&
          !String(m.content).startsWith("__STATUS__:")
        );
      const text = (msg?.content || "").trim();
      console.log("[AUTO-SPEAK:2] text to speak=", text.slice(0,60));
      if (!text || text === lastSpokenRef.current) return;
      lastSpokenRef.current = text;
      console.log("[AUTO-SPEAK:3] calling ttsSpeak");
      await ttsSpeak(text, vs);
      console.log("[AUTO-SPEAK:4] ttsSpeak done");
    } catch (e) {
      console.warn("[AUTO-SPEAK] failed:", e);
    }
}

/**
 * Register global TTS helper used by VoicePanel autoSpeak
 */
useEffect(() => {
  // Called by VoicePanel when mic opens
  (window as any).__nikolai_voice_session_start = () => {
    voiceSessionActiveRef.current = true;
    console.log("[VOICE] session activated — auto-speak enabled");
  };

  // Called by VoicePanel when mic closes
  (window as any).__nikolai_voice_session_end = () => {
    voiceSessionActiveRef.current = false;
    console.log("[VOICE] session deactivated — auto-speak paused");
  };

  (window as any).__nikolai_tts_last = async () => {
    try {
      const vs = loadVoiceSettings();

      if (!vs.autoSpeak || !voiceSessionActiveRef.current) {
        return;
      }

      const all = loadChats();
      const id = loadActiveChatId();
      const thread = all.find((c) => c.id === id) || all[0];

      const msg = thread?.messages
        ?.slice()
        .reverse()
        .find(
          (m) =>
            m.role === "assistant" &&
            (m.content || "").trim().length > 0 &&
            !String(m.content).startsWith("__STATUS__:")
        );

      const text = (msg?.content || "").trim();
      if (!text) return;

      await ttsSpeak(text, vs);
    } catch (e) {
      console.warn("[__nikolai_tts_last] failed:", e);
    }
  };

  return () => {
    delete (window as any).__nikolai_tts_last;
    delete (window as any).__nikolai_voice_session_start;
    delete (window as any).__nikolai_voice_session_end;
  };
}, []);

  const regenerateLast = async () => {
    const chat = activeChat;
    if (!chat || isStreaming) return;

    const msgs = chat.messages || [];
    let userIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { userIdx = i; break; }
    }
    if (userIdx < 0) return;

    let asstIdx = -1;
    for (let i = msgs.length - 1; i > userIdx; i--) {
      if (msgs[i].role === "assistant") { asstIdx = i; break; }
    }
    if (asstIdx < 0) return;

    const prompt = (msgs[userIdx].content || "").trim();
    if (!prompt || prompt.startsWith("/")) return;

    const assistantMsgId = chat.messages[asstIdx]?.id;
    if (!assistantMsgId) return;

    setChats((prev) => {
      const next = prev.map((c) => {
        if (c.id !== chat.id) return c;
        return { ...c, updatedAt: Date.now(), messages: c.messages.map((m, idx) => idx === asstIdx ? { ...m, content: "" } : m) };
      });
      return next;
    });

    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const baseHistory = msgs
        .slice(0, userIdx + 1)
        .filter((m) => m.role === "user" || (m.content || "").trim().length > 0)
        .filter((m) => !String(m.content || "").startsWith("__STATUS__:"))
        .map((m) => ({ role: (m.role as Message["role"]), content: String(m.content ?? "") }));

      const onToken = createStreamingTokenHandler(chat.id, assistantMsgId);
      const onStatus = (s: string) => setAgentStatus(s);
      const isOllama = provider?.kind === "ollama";

      const useAgent = shouldUseAgentic(prompt) && getCachedTools().length > 0;
      console.log(`[ROUTING] ${useAgent ? "AGENT" : "CHAT"} — "${prompt.slice(0, 60)}"`);

      if (useAgent) {
        const agenticChatFn = isOllama ? undefined : async (msgs: any[], signal: AbortSignal) => {
          let result = "";
          await streamChatWithProvider({ provider, messages: msgs, signal, onToken: (t: string) => { result += t; } });
          return result;
        };
        const agenticStreamFn = isOllama ? undefined : async (msgs: any[], signal: AbortSignal, onTok: (t: string) => void) => {
          await streamChatWithProvider({ provider, messages: msgs, signal, onToken: onTok });
        };
        await agenticStreamChat({
          baseUrl: provider.ollamaBaseUrl,
          model: provider.ollamaModel,
          messages: baseHistory as any,
          signal: controller.signal,
          onToken, onStatus,
          maxSteps: 10,
          executeTool: executeToolWithApproval,
          plannerModel: ((provider as any)?.ollamaPlannerModel || provider.ollamaModel),
          chatFn: agenticChatFn,
          streamFn: agenticStreamFn,
          prompt,  // Pass original prompt for tool filtering
        });
      } else {
        if (isOllama) {
          await ollamaStreamChat({ baseUrl: provider.ollamaBaseUrl, model: provider.ollamaModel, messages: baseHistory, signal: controller.signal, onToken });
        } else {
          await streamChatWithProvider({ provider, messages: baseHistory as any, signal: controller.signal, onToken });
        }
      }
    } catch (err) {
      if (err instanceof StreamTimeoutError) {
        console.warn("[APP] stream timeout handled");
        return;
      }
      console.warn("stream error:", err);
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
      setAgentStatus("");
      finalizeStreaming(chat.id, assistantMsgId);
      void maybeAutoSpeakLastAssistant(chat.id);
    }
  };

  // ── V3: Per-chat system prompt ─────────────────────────────────────────────
  const updateSystemPrompt = useCallback((chatId: string, prompt: string) => {
    setChats((prev) => {
      const next = prev.map((c) =>
        c.id === chatId ? { ...c, systemPrompt: prompt || undefined, updatedAt: Date.now() } : c
      );
      return next;
    });
  }, []);

  const send = async (text: string, images?: string[]) => {
    console.log("[CHAT] user message", text);
    if (sendingRef.current) return;   // block double-send
    let chat = activeChat;
    if (!chat) { 
      console.log("[CHAT] no active chat - calling createChat");
      const newChatId = await createChat();
      console.log("[CHAT] after createChat", { newChatId, chatsLength: chatsRef.current.length });
      // Get the newly created chat from ref (which has latest state)
      chat = chatsRef.current.find(c => c.id === newChatId) || null;
      if (!chat) {
        console.log("[CHAT] still no chat after createChat - returning");
        return;
      }
    }
    if (isStreaming) return;

    const userMsg: Message = { id: uid("m"), role: "user", content: text, ts: Date.now(), ...(images && images.length > 0 ? { images } : {}) };
    const assistantMsgId = uid("m");
    const assistantMsg: Message = { id: assistantMsgId, role: "assistant", content: "", ts: Date.now() + 1 };

    // Reset assistant text accumulator for this message
    assistantTextRef.current = "";

    const updatedChats = chats.map((c) =>
      c.id === chat!.id ? { ...c, updatedAt: Date.now(), messages: [...c.messages, userMsg, assistantMsg] } : c
    );
    console.log("[CHAT] updating chats", { chatId: chat!.id, messageCount: updatedChats.find(c => c.id === chat!.id)?.messages.length });
    persist(updatedChats);
    console.log("[CHAT] after persist", { chats: chats.length, activeId });

    const trimmed = text.trim();

    // ── /tools command ────────────────────────────────────────────────────────
    // Priority 5: reads from the in-memory cache — no MCP round-trip.
    // The tools are already loaded when the user types /tools.
    if (trimmed.toLowerCase() === "/tools") {
      const tools = getCachedTools(); // ← was: await mcpListTools() — now instant

      if (tools.length > 0) {
        appendToolLog({ id: `tl-${Date.now()}`, ts: Date.now(), tool: "getCachedTools", args: {}, ok: true, result: { count: tools.length } });
      }

      const lines = tools.map((t: any) => `- ${t.name}${t?.description ? ` — ${t.description}` : ""}`);
      const msg = lines.length > 0
        ? `Available tools (${lines.length}):\n` + lines.join("\n")
        : "No tools loaded. MCP not connected, or tools haven't loaded yet — try Refresh in the Tools tab.";

      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chat!.id) return c;
          return { ...c, updatedAt: Date.now(), messages: c.messages.map((m) => m.id === assistantMsgId ? { ...m, content: msg } : m) };
        });
        // Persist the assistant message to SQLite
        saveMessage(chat!.id, 'assistant', msg).catch(console.error);
        return next;
      });
      void maybeAutoSpeakLastAssistant(chat!.id);
      return;
    }

    // ── /tool <n> {args} command ───────────────────────────────────────────
    const toolCmd = parseToolCommand(text);
    if (toolCmd) {
      if (!toolCmd.ok) {
        const errorMsg = `⚠️ **Tool command error:**\n\`\`\`\n${toolCmd.error}\n\`\`\``;
        setChats((prev) => {
          const next = prev.map((c) => {
            if (c.id !== chat!.id) return c;
            return {
              ...c, updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: errorMsg }
                  : m
              ),
            };
          });
          // Persist the assistant message to SQLite
          saveMessage(chat!.id, 'assistant', errorMsg).catch(console.error);
          return next;
        });
        return;
      }

      // Resolve relative paths in /tool commands the same way as agentic tool calls
      try {
        const wsRootForCmd = await getWsRoot();
        const resolvedArgs = normalizeFsArgs(toolCmd.name, toolCmd.args || {}, wsRootForCmd);

        // NEW: block absolute paths outside root for fs.* tools
        enforceFsArgsUnderRoot(toolCmd.name, resolvedArgs, wsRootForCmd);

        const out = await mcpCallTool(toolCmd.name, resolvedArgs);
        const formatted = formatToolResult(toolCmd.name, out);
        if (formatted.isError) throw new Error(formatted.text || "Tool returned error");
        setChats((prev) => {
          const next = prev.map((c) => {
            if (c.id !== chat!.id) return c;
            return { ...c, updatedAt: Date.now(), messages: c.messages.map((m) => m.id === assistantMsgId ? { ...m, content: formatted.text } : m) };
          });
          // Persist the assistant message to SQLite
          saveMessage(chat!.id, 'assistant', formatted.text).catch(console.error);
          return next;
        });
      } catch (e: any) {
        const errorText = `⚠️ **Tool error** (${toolCmd.name})\n\n${e?.message || String(e)}`;
        setChats((prev) => {
          const next = prev.map((c) => {
            if (c.id !== chat!.id) return c;
            return {
              ...c, updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: errorText }
                  : m
              ),
            };
          });
          // Persist the assistant message to SQLite
          saveMessage(chat!.id, 'assistant', errorText).catch(console.error);
          return next;
        });
      } finally {
        void maybeAutoSpeakLastAssistant(chat!.id);
      }
      return;
    }

    // ── Chat / agentic stream ─────────────────────────────────────────────────
    sendingRef.current = true;
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    let msgStartTime = 0;
    let tokenResult: { promptTokens: number; completionTokens: number } | undefined;

    try {
      msgStartTime = Date.now();
      // Use updatedChats (already has the new user message) — avoids a disk read
      const currentChat = updatedChats.find((c) => c.id === chat!.id);

      const history = (currentChat?.messages || [])
        .filter((m) => m.role === "user" || (m.content || "").trim().length > 0)
        .filter((m) => !String(m.content || "").startsWith("__STATUS__:"))
        .map((m) => ({
          role: (m.role as Message["role"]),
          content: String(m.content ?? ""),
          ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
        }));

      // ── V3: Prepend system prompt if set for this chat ─────────────────────
      const sysPrompt = (currentChat as any)?.systemPrompt?.trim();
      const historyWithSys: typeof history = sysPrompt
        ? [{ role: "system" as const, content: sysPrompt }, ...history]
        : history;

      const onToken = createStreamingTokenHandler(chat!.id, assistantMsgId);
      const onStatus = (s: string) => setAgentStatus(s);
      const isOllama = provider?.kind === "ollama";

      // Guard: only attempt agentic if MCP tools are loaded.
      // getCachedTools() returns [] when MCP is disconnected — no point starting
      // the planner when it will immediately fail with "no tools available".
      if (shouldUseAgentic(text) && getCachedTools().length > 0) {
        // Build provider-agnostic planner/stream fns so any provider can drive tools
        const agenticChatFn = isOllama ? undefined : async (msgs: any[], signal: AbortSignal) => {
          let result = "";
          await streamChatWithProvider({ provider, messages: msgs, signal, onToken: (t: string) => { result += t; } });
          return result;
        };
        const agenticStreamFn = isOllama ? undefined : async (msgs: any[], signal: AbortSignal, onTok: (t: string) => void) => {
          await streamChatWithProvider({ provider, messages: msgs, signal, onToken: onTok });
        };
        await agenticStreamChat({
          baseUrl: provider.ollamaBaseUrl,
          model: provider.ollamaModel,
          messages: historyWithSys as any,
          signal: controller.signal,
          onToken, onStatus,
          maxSteps: 10,
          executeTool: executeToolWithApproval,
          plannerModel: ((provider as any)?.ollamaPlannerModel || provider.ollamaModel),
          chatFn: agenticChatFn,
          streamFn: agenticStreamFn,
        });
      } else {
        if (isOllama) {
          tokenResult = await ollamaStreamChat({ baseUrl: provider.ollamaBaseUrl, model: provider.ollamaModel, messages: historyWithSys, signal: controller.signal, onToken });
        } else {
          await streamChatWithProvider({ provider, messages: history as any, signal: controller.signal, onToken });
        }
      }
    } finally {
      sendingRef.current = false;
      abortRef.current = null;
      setIsStreaming(false);
      setAgentStatus("");
      finalizeStreaming(chat!.id, assistantMsgId);
      autoTitleChat(chat!.id, text);          // set title from first user message
      void maybeAutoSpeakLastAssistant(chat!.id);

      const assistantText = assistantTextRef.current || "";
      console.log("[CHAT] assistant complete", {
        textLength: assistantText.length,
        text: assistantText.slice(0, 100)
      });

      // Track usage for non-agentic chat messages
      try {
        // Use real tokens if available, otherwise fall back to estimation
        const promptTokens = tokenResult?.promptTokens ?? estimateTokensFromText(text);
        // If Ollama returned 0 tokens or tokenResult is missing, fall back to estimation
        const completionTokens =
          tokenResult && tokenResult.completionTokens > 0
            ? tokenResult.completionTokens
            : estimateTokensFromText(assistantText);

        logUsage({
          timestamp: Date.now(),
          type: "chat",
          model: provider.ollamaModel,
          promptTokens,
          completionTokens,
          estimatedTokens: promptTokens + completionTokens,
          durationMs: Date.now() - msgStartTime
        });
      } catch (err) {
        console.warn("[usageLog] failed to record chat usage", err);
      }
    }
  };

  useEffect(() => {
    (window as any).__nikolai_send = send;
    return () => { if ((window as any).__nikolai_send === send) delete (window as any).__nikolai_send; };
  }, [send]);

  return (
    <ErrorBoundary>
      <>
        <ResizableShell
          left={
            <ChatHistory
              collapsed={leftCollapsed}
              chats={chats}
              activeId={activeId}
              onSelect={selectChat}
              onCreate={createChat}
              onDelete={deleteChat}
              onRename={renameChat}
              loading={loading}
            />
          }
          center={
            <ChatCenter
              chat={activeChat}
              onSend={send}
              isStreaming={isStreaming}
              isThinking={isThinking}
              onStop={stop}
              onRegenerate={regenerateLast}
              canRegenerate={!isStreaming}
              onClearStatus={clearStatusForActiveChat}
              agentStatus={agentStatus}
              onUpdateSystemPrompt={updateSystemPrompt}
            />
          }
          right={<RightPanel collapsed={rightCollapsed} provider={provider} setProvider={setProvider} chats={chats} activeId={activeId} />}
          onToggleLeft={(c) => setLeftCollapsed(c)}
          onToggleRight={(c) => setRightCollapsed(c)}
        />

        <ToolApprovalModal
          open={toolApproval.open}
          toolName={toolApproval.toolName}
          toolArgs={toolApproval.toolArgs}
          onDeny={() => closeToolApproval("deny")}
          onAllowOnce={() => closeToolApproval("once")}
          onAllowChat={() => closeToolApproval("chat")}
        />

        {import.meta.env.DEV && <TestRecorder />}
      </>
    </ErrorBoundary>
  );
}
