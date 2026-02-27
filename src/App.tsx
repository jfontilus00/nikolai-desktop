import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatThread, Message, ProviderConfig } from "./types";
import { uid } from "./lib/id";
import {
  loadActiveChatId,
  loadChats,
  saveActiveChatId,
  saveChats,
  loadLayout,
  loadProvider,
  saveProvider,
} from "./lib/storage";
import ResizableShell from "./components/ResizableShell";
import ChatHistory from "./components/ChatHistory";
import ChatCenter from "./components/ChatCenter";
import RightPanel from "./components/RightPanel";
import ToolApprovalModal from "./components/ToolApprovalModal";
import ErrorBoundary from "./components/ErrorBoundary";
import { ollamaStreamChat } from "./lib/ollamaStream";
import { streamChatWithProvider } from "./lib/providerStream";
import { agenticStreamChat } from "./lib/agentic";
import { parseToolCommand } from "./lib/toolCmd";
import { mcpCallTool, getCachedTools } from "./lib/mcp"; // ← Priority 5: getCachedTools replaces mcpListTools for /tools
import { appendToolLog } from "./lib/toolLog";
import { formatToolResult } from "./lib/toolResult";
import { withTimeout } from "./lib/timeout";

// Voice
import { loadVoiceSettings } from "./lib/voiceSettings";
import { ttsSpeak } from "./lib/ttsClient";

// ── Agentic trigger heuristic ─────────────────────────────────────────────────
function shouldUseAgentic(text: string) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  if (t.startsWith("/")) return false;

  if (t.startsWith("use tool") || t.startsWith("run tool") || t.startsWith("call tool")) return true;

  // Verb list is intentionally narrow. "find", "get", "show me", "give me" removed
  // because they fire on casual phrases ("find me a recipe", "get me a summary").
  // These verbs only make sense when paired with a genuine file noun below.
  const actionVerbs = /\b(read|open|write|create|generate|export|analyse|analyze|refactor|fix|update|edit|search|list)\b/;
  const fileNouns   = /\b(file|files|folder|directory|project|codebase|repo|docx|pdf|pptx|xlsx|report|diagram|mermaid|source)\b/;

  if (actionVerbs.test(t) && fileNouns.test(t)) return true;
  if (/\b(ls|grep|cat|find)\b/.test(t)) return true;

  return false;
}

function newChat(): ChatThread {
  const id = uid("chat");
  const now = Date.now();
  return { id, title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

export default function App() {
  const [chats, setChats] = useState<ChatThread[]>(() => loadChats());
  const chatsRef = useRef<ChatThread[]>(chats);
  useEffect(() => { chatsRef.current = chats; }, [chats]);

  const [activeId, setActiveId] = useState<string | null>(() => loadActiveChatId());
  const [leftCollapsed, setLeftCollapsed] = useState(() => loadLayout().leftCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(() => loadLayout().rightCollapsed);

  const [provider, setProviderState] = useState<ProviderConfig>(() => loadProvider());
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ── Priority 4: Agent status — ephemeral React state, never in message content
  const [agentStatus, setAgentStatus] = useState<string>("");

  // 20s ceiling — if a tool hangs longer than this the UX is already broken.
  // 45s was too high; at 10 steps worst-case that was 7.5 minutes of silence.
  const TOOL_TIMEOUT_MS = 20000;

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
    (chatId: string, messageId: string, forcePersist: boolean = false) => {
      const buffers = streamingBuffersRef.current;
      const buf = buffers.get(messageId);
      if (!buf || !buf.pending || buf.chatId !== chatId) return;

      const content = buf.chunks.join("");
      buf.chunks = [];
      buf.pending = false;
      if (!content) return;

      const now = Date.now();
      const shouldPersist = forcePersist || now - buf.lastPersist > 500;

      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          const msgs = c.messages.map((m) =>
            m.id === messageId ? { ...m, content: (m.content || "") + content } : m
          );
          return { ...c, updatedAt: Date.now(), messages: msgs };
        });
        if (shouldPersist) {
          buf.lastPersist = now;
          saveChats(next);
        }
        return next;
      });
    },
    []
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
      if (modified) saveChats(currentChats);
      buffers.clear();
    };
  }, []);

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
    return String(p || "").trim().replace(/^"(.*)"$/, "$1").replace(/\\/g, "/");
  }

  function normalizeFsArgs(_tool: string, a: any) {
    const args = a && typeof a === "object" ? { ...a } : {};
    for (const k of ["path", "src", "dst", "from", "to"]) {
      if (typeof (args as any)[k] === "string") {
        (args as any)[k] = normalizeWinPath((args as any)[k]);
      }
    }
    return args;
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

  const executeToolWithApproval = async (name: string, args: any) => {
    const normalizedArgs = normalizeFsArgs(name, args);
    const v = validateToolArgs(name, normalizedArgs);
    if (!v.ok) throw new Error(`Tool args invalid: ${v.error}`);

    if (toolAllowInChat[`${activeId || "nochat"}::${name}`]) {
      return await withTimeout(mcpCallTool(name, normalizedArgs), TOOL_TIMEOUT_MS, `Tool timeout: ${name}`);
    }

    const choice = await requestToolApproval(name, normalizedArgs);
    if (choice === "deny") throw new Error("Tool denied by user");
    if (choice === "chat") {
      setToolAllowInChat((prev) => {
        const next = { ...prev, [`${activeId || "nochat"}::${name}`]: true };
        try { sessionStorage.setItem("nikolai.tool.allow", JSON.stringify(next)); } catch {}
        return next;
      });
    }
    return await withTimeout(mcpCallTool(name, normalizedArgs), TOOL_TIMEOUT_MS, `Tool timeout: ${name}`);
  };

  const activeChat = useMemo(() => chats.find((c) => c.id === activeId) || null, [chats, activeId]);

  const persist = (next: ChatThread[], nextActive?: string | null) => {
    setChats(next);
    saveChats(next);
    if (typeof nextActive !== "undefined") {
      setActiveId(nextActive);
      saveActiveChatId(nextActive);
    }
  };

  const setProvider = (p: ProviderConfig) => {
    setProviderState(p);
    saveProvider(p);
  };

  const createChat = () => {
    const c = newChat();
    persist([c, ...chats], c.id);
  };

  const deleteChat = (id: string) => {
    const next = chats.filter((c) => c.id !== id);
    persist(next, activeId === id ? (next[0]?.id ?? null) : activeId);
  };

  const renameChat = (id: string, title: string) => {
    persist(chats.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)));
  };

  const selectChat = (id: string) => {
    setActiveId(id);
    saveActiveChatId(id);
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
      saveChats(next);
      return next;
    });
  };

  // Guard against double-send (e.g. double-click, rapid Enter presses)
  const sendingRef = useRef(false);

  // Tracks last spoken text to avoid re-speaking the same message on re-render
  const lastSpokenRef = useRef<string>("");


  // Truncates to 40 chars — enough to distinguish chats in the sidebar.
  const autoTitleChat = useCallback((chatId: string, userText: string) => {
    setChats((prev) => {
      const chat = prev.find((c) => c.id === chatId);
      if (!chat || chat.title !== "New chat") return prev;
      const raw   = userText.trim().replace(/\n/g, " ");
      const title = raw.length > 40 ? raw.slice(0, 40) + "…" : raw;
      const next  = prev.map((c) => c.id === chatId ? { ...c, title, updatedAt: Date.now() } : c);
      saveChats(next);
      return next;
    });
  }, []);

  async function maybeAutoSpeakLastAssistant(chatId?: string) {
    try {
      const vs = loadVoiceSettings();
      if (!vs.autoSpeak) return;
      const all = loadChats();
      const id = chatId || loadActiveChatId();
      const thread = all.find((c) => c.id === id) || all[0];
      const msg = thread?.messages
        ?.slice().reverse()
        .find((m) =>
          m.role === "assistant" &&
          (m.content || "").trim().length > 0 &&
          !String(m.content).startsWith("__STATUS__:")
        );
      const text = (msg?.content || "").trim();
      if (!text || text === lastSpokenRef.current) return;
      lastSpokenRef.current = text;
      await ttsSpeak(text, vs);
      if (vs.autoListenAfterSpeak) {
        const start = (window as any).__nikolai_voice_start;
        if (typeof start === "function") setTimeout(() => { try { start(); } catch {} }, 250);
      }
    } catch { }
  }

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
      saveChats(next);
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
      const isOllama = ((provider as any)?.kind || "ollama") === "ollama";

      if (isOllama && shouldUseAgentic(prompt) && getCachedTools().length > 0) {
        await agenticStreamChat({
          baseUrl: provider.ollamaBaseUrl,
          model: provider.ollamaModel,
          messages: baseHistory as any,
          signal: controller.signal,
          onToken, onStatus,
          maxSteps: 10,
          executeTool: executeToolWithApproval,
          plannerModel: ((provider as any)?.ollamaPlannerModel || provider.ollamaModel),
        });
      } else {
        if (isOllama) {
          await ollamaStreamChat({ baseUrl: provider.ollamaBaseUrl, model: provider.ollamaModel, messages: baseHistory, signal: controller.signal, onToken });
        } else {
          await streamChatWithProvider({ provider, messages: baseHistory as any, signal: controller.signal, onToken });
        }
      }
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
      saveChats(next);
      return next;
    });
  }, []);

  const send = async (text: string, images?: string[]) => {
    if (sendingRef.current) return;   // block double-send
    let chat = activeChat;
    if (!chat) { createChat(); return; }
    if (isStreaming) return;

    const userMsg: Message = { id: uid("m"), role: "user", content: text, ts: Date.now(), ...(images && images.length > 0 ? { images } : {}) };
    const assistantMsgId = uid("m");
    const assistantMsg: Message = { id: assistantMsgId, role: "assistant", content: "", ts: Date.now() + 1 };

    const updatedChats = chats.map((c) =>
      c.id === chat!.id ? { ...c, updatedAt: Date.now(), messages: [...c.messages, userMsg, assistantMsg] } : c
    );
    persist(updatedChats);

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
        saveChats(next);
        return next;
      });
      void maybeAutoSpeakLastAssistant(chat!.id);
      return;
    }

    // ── /tool <n> {args} command ───────────────────────────────────────────
    const toolCmd = parseToolCommand(text);
    if (toolCmd) {
      if (!toolCmd.ok) {
        setChats((prev) => {
          const next = prev.map((c) => {
            if (c.id !== chat!.id) return c;
            return {
              ...c, updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: `⚠️ **Tool command error:**\n\`\`\`\n${toolCmd.error}\n\`\`\`` }
                  : m
              ),
            };
          });
          saveChats(next);
          return next;
        });
        return;
      }

      try {
        const out = await mcpCallTool(toolCmd.name, toolCmd.args || {});
        const formatted = formatToolResult(toolCmd.name, out);
        if (formatted.isError) throw new Error(formatted.text || "Tool returned error");
        setChats((prev) => {
          const next = prev.map((c) => {
            if (c.id !== chat!.id) return c;
            return { ...c, updatedAt: Date.now(), messages: c.messages.map((m) => m.id === assistantMsgId ? { ...m, content: formatted.text } : m) };
          });
          saveChats(next);
          return next;
        });
      } catch (e: any) {
        setChats((prev) => {
          const next = prev.map((c) => {
            if (c.id !== chat!.id) return c;
            return {
              ...c, updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: `⚠️ **Tool error** (${toolCmd.name})\n\n${e?.message || String(e)}` }
                  : m
              ),
            };
          });
          saveChats(next);
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

    try {
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
      const isOllama = ((provider as any)?.kind || "ollama") === "ollama";

      // Guard: only attempt agentic if MCP tools are loaded.
      // getCachedTools() returns [] when MCP is disconnected — no point starting
      // the planner when it will immediately fail with "no tools available".
      if (isOllama && shouldUseAgentic(text) && getCachedTools().length > 0) {
        await agenticStreamChat({
          baseUrl: provider.ollamaBaseUrl,
          model: provider.ollamaModel,
          messages: historyWithSys as any,
          signal: controller.signal,
          onToken, onStatus,
          maxSteps: 10,
          executeTool: executeToolWithApproval,
          plannerModel: ((provider as any)?.ollamaPlannerModel || provider.ollamaModel),
        });
      } else {
        if (isOllama) {
          await ollamaStreamChat({ baseUrl: provider.ollamaBaseUrl, model: provider.ollamaModel, messages: historyWithSys, signal: controller.signal, onToken });
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
            />
          }
          center={
            <ChatCenter
              chat={activeChat}
              onSend={send}
              isStreaming={isStreaming}
              onStop={stop}
              onRegenerate={regenerateLast}
              canRegenerate={!isStreaming}
              onClearStatus={clearStatusForActiveChat}
              agentStatus={agentStatus}
              onUpdateSystemPrompt={updateSystemPrompt}
            />
          }
          right={<RightPanel collapsed={rightCollapsed} provider={provider} setProvider={setProvider} />}
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
      </>
    </ErrorBoundary>
  );
}