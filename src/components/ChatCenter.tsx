import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatThread, Message } from "../types";
import { useMcp } from "../lib/mcp";
import { copyText } from "../lib/clipboard";
import { createHighlighter, type Highlighter } from "shiki";

// Tauri event listener — guarded so it doesn't crash in plain browser dev mode
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI__;
type ListenFn = typeof import("@tauri-apps/api/event").listen;
let tauriListen: ListenFn | null = null;
if (isTauri) {
  import("@tauri-apps/api/event").then((m) => { tauriListen = m.listen; }).catch(() => {});
}

// ── Syntax highlighting with Shiki ────────────────────────────────────────────
// Syntax highlighting with Shiki disabled — unused variable removed
// let highlighter: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: ["typescript", "javascript", "python", "rust", "bash", "json", "tsx", "jsx", "css", "html", "sql", "markdown"]
    }).then(hl => { return hl; });
  }
  return highlighterPromise;
}

async function highlightCode(code: string, lang: string): Promise<string> {
  try {
    const hl = await getHighlighter();
    return hl.codeToHtml(code, { lang: lang || "text", theme: "github-dark" });
  } catch {
    // Fallback to plain text if highlighting fails
    return `<pre><code>${code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`;
  }
}

type Props = {
  chat: ChatThread | null;
  onSend: (text: string, images?: string[]) => void;
  isStreaming: boolean;
  isThinking?: boolean;
  onStop: () => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
  onClearStatus?: () => void;
  agentStatus?: string;
  onUpdateSystemPrompt?: (chatId: string, prompt: string) => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeLegacyStatusLines(s: string) {
  if (!s) return s;
  return s.split(/\r?\n/).filter((ln) => {
    const t = ln.trim();
    if (!t) return true;
    if (t.startsWith("Running:") || t.startsWith("Done:")) return false;
    return true;
  }).join("\n").trim();
}

function guardIdentityDisplay(text: string) {
  const s = (text || "").trimStart();
  const head = s.slice(0, 220).toLowerCase();
  const bad =
    head.startsWith("yes, i am kimi") || head.startsWith("i am kimi") ||
    head.startsWith("i'm kimi") || head.startsWith("yes, i'm kimi") ||
    head.startsWith("yes, i am claude") || head.startsWith("i am claude") ||
    head.startsWith("i'm claude") || head.startsWith("yes, i am chatgpt") ||
    head.startsWith("i am chatgpt") || head.startsWith("i'm chatgpt") ||
    head.includes("created by moonshot") || head.includes("moonshot ai");
  if (!bad) return text;
  const lines = s.split(/\r?\n/);
  lines[0] = "I'm NikolAi (Atelier NikolAi Desktop). How can I help?";
  return lines.join("\n");
}

// ── V3: Image helpers ─────────────────────────────────────────────────────────

// Read a File or Blob as raw base64 (no data: prefix)
function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // Strip "data:image/...;base64," prefix
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

async function extractImagesFromDataTransfer(dt: DataTransfer): Promise<string[]> {
  const results: string[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && IMAGE_MIME.has(item.type)) {
      const file = item.getAsFile();
      if (file) results.push(await fileToBase64(file));
    }
  }
  return results;
}

// ── V4-A: PDF text extraction ─────────────────────────────────────────────────
// Uses pdfjs-dist (lazy dynamic import — only loaded when a PDF is dropped).
// Run: npm install pdfjs-dist   (one-time, in the project root)
//
// Extracted text is injected as a fenced block at the top of the user message
// so any model (including non-vision) can read and reason about the document.

type PendingPdf = { name: string; text: string; pages: number };

async function extractPdfText(file: File): Promise<PendingPdf> {
  const pdfjs = await import("pdfjs-dist");
  // Standard Vite worker reference — avoids ?url query that breaks Babel
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.js",
    import.meta.url
  ).href;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = (content.items as any[])
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ").replace(/\s+/g, " ").trim();
    if (pageText) pages.push(`--- Page ${i} ---\n${pageText}`);
  }
  return { name: file.name, text: pages.join("\n\n"), pages: pdf.numPages };
}

function formatPdfBlock(pdf: PendingPdf): string {
  const preview = pdf.text.length > 8000
    ? pdf.text.slice(0, 8000) + `\n\n[… truncated — ${pdf.text.length - 8000} more chars]`
    : pdf.text;
  return `[PDF: ${pdf.name} (${pdf.pages}p)]\n\`\`\`text\n${preview}\n\`\`\`\n\n`;
}

function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ── Tool card helpers ─────────────────────────────────────────────────────────

// Derive server label from tool name prefix — same logic as ToolApprovalModal
function serverFromTool(name: string): string {
  if (name.startsWith("fs."))            return "FS";
  if (name.startsWith("doc-suite."))     return "DOC-SUITE";
  if (name.startsWith("hub."))           return "HUB";
  if (name.startsWith("project-brain.")) return "PROJECT-BRAIN";
  if (name === "batch_commit")           return "WORKSPACE";
  const parts = name.split(".");
  return parts.length > 1 ? parts[0].toUpperCase() : "MCP";
}

// Parse the tool name out of a summary line.
// Summary examples:
//   "✓ Read src/App.tsx (1234 chars)"
//   "✓ Staged src/index.ts for batch write"
//   "✗ write_file failed: Permission denied"
//   "✓ Committed 3 file(s) atomically (batch ID: 1740000)"
function toolNameFromSummary(summary: string): string {
  const s = summary.replace(/^[✓✗]\s*/, "");
  if (s.startsWith("Read "))            return "fs.read_file";
  if (s.startsWith("Staged "))          return "fs.write_file";
  if (s.startsWith("Edited "))          return "fs.edit_file";
  if (s.startsWith("Listed "))          return "fs.list_directory";
  if (s.startsWith("Searched "))        return "fs.search_files";
  if (s.startsWith("Committed "))       return "batch_commit";
  if (s.startsWith("Rolled back"))      return "batch_rollback";
  if (s.toLowerCase().includes("export")) return "doc-suite.export";
  if (s.toLowerCase().includes("hub"))    return "hub.tool";
  if (s.toLowerCase().includes("brain"))  return "project-brain.query";
  // fallback: take the first word as the bare name
  return s.split(" ")[0]?.toLowerCase() ?? "tool";
}

// Parse the **Actions taken:** block emitted by agentic.ts.
// Returns null if the message has no such block (plain chat message).
type ActionStep = {
  ok: boolean;
  summary: string;       // the display summary text after ✓/✗ (stripped of metadata)
  toolName: string;      // inferred tool name
  server: string;        // inferred server label
  // ── Diff metadata ─────────────────────────────────────────────────────────
  // Populated when agentic.ts appends ||{json} to the action line.
  // Used to show file content / diff in the expanded card without extra IPC.
  filePath?: string;
  contentPreview?: string;
  contentLength?: number;
  truncated?: boolean;
  files?: string[];      // for batch_commit
};

type ParsedAgentMessage = {
  steps: ActionStep[];
  answerText: string;    // text after the --- divider
};

const ACTIONS_MARKER = "**Actions taken:**\n";
const DIVIDER        = "\n\n---\n\n";

function parseAgentMessage(content: string): ParsedAgentMessage | null {
  const markerIdx = content.indexOf(ACTIONS_MARKER);
  if (markerIdx < 0) return null;

  const afterMarker = content.slice(markerIdx + ACTIONS_MARKER.length);
  const dividerIdx  = afterMarker.indexOf(DIVIDER);

  const actionBlock = dividerIdx >= 0 ? afterMarker.slice(0, dividerIdx) : afterMarker;
  const answerText  = dividerIdx >= 0 ? afterMarker.slice(dividerIdx + DIVIDER.length) : "";

  const steps: ActionStep[] = actionBlock
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => {
      const raw = l.slice(2).trim();

      // ── Extract ||{json} metadata appended by agentic.ts ──────────────────
      const metaSep = raw.indexOf("||");
      let displayText = raw;
      let meta: Record<string, any> = {};

      if (metaSep >= 0) {
        displayText = raw.slice(0, metaSep);
        try { meta = JSON.parse(raw.slice(metaSep + 2)); } catch { /* ignore */ }
      }

      const ok      = displayText.startsWith("✓");
      const summary = displayText.slice(1).trim();
      const toolName = toolNameFromSummary(displayText);

      return {
        ok,
        summary,
        toolName,
        server:         serverFromTool(toolName),
        filePath:       meta.path,
        contentPreview: meta.contentPreview,
        contentLength:  meta.contentLength,
        truncated:      meta.truncated,
        files:          meta.files,
      };
    });

  if (steps.length === 0) return null;
  return { steps, answerText };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Avatar({ kind }: { kind: "user" | "assistant" }) {
  const label = kind === "assistant" ? "N" : "U";
  const cls = kind === "assistant"
    ? "bg-white/10 border border-white/15 text-white/90"
    : "bg-blue-600/30 border border-blue-500/30 text-blue-100";
  return (
    <div className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold ${cls}`}>
      {label}
    </div>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    highlightCode(code, lang || "").then(setHtml);
  }, [code, lang]);

  return (
    <div className="relative my-2">
      <button
        className="absolute top-2 right-2 text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/10"
        onClick={async () => {
          if (await copyText(code)) { setCopied(true); setTimeout(() => setCopied(false), 1200); }
        }}
        aria-label="Copy code to clipboard"
        title="Copy code to clipboard"
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
      <div
        className="text-xs overflow-x-auto rounded-lg bg-black/40 border border-white/10"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function Md({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="leading-relaxed my-2">{children}</p>,
        code: ({ children, className }) => {
          const raw  = String(children ?? "");
          const code = raw.replace(/\n$/, "");
          const isBlock = (className || "").includes("language-") || raw.includes("\n");
          // Extract language from className (e.g., "language-typescript" → "typescript")
          const lang = className?.replace("language-", "") || "";
          if (isBlock) return <CodeBlock code={code} lang={lang} />;
          return <code className="text-xs rounded bg-black/40 border border-white/10 px-1 py-0.5">{children}</code>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

// ── Tool action step card ─────────────────────────────────────────────────────
// Renders a single step from the "Actions taken" block as a visual card
// matching the style of image 3: ✦ Call [tool] from [server] + status.

function ToolStepCard({ step }: { step: ActionStep }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Has expandable content if there's a content preview, file list, or detail text
  const hasContent = !!(step.contentPreview || (step.files && step.files.length > 0) || step.summary.includes("(") || step.summary.includes(":"));

  // Detect language for syntax highlighting label
  const ext = step.filePath?.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", json: "json", md: "markdown", css: "css",
    html: "html", txt: "text", toml: "toml", yaml: "yaml", yml: "yaml",
  };
  const lang = langMap[ext] ?? ext ?? "text";

  return (
    <div
      className={`flex flex-col rounded-lg border text-[12px] overflow-hidden transition-all ${
        step.ok
          ? "bg-white/[0.03] border-white/8"
          : "bg-red-950/20 border-red-800/25"
      }`}
    >
      {/* ── Header row ─────────────────────────────────────────────────────── */}
      <div
        className={`flex items-center gap-2 px-3 py-2 ${hasContent ? "cursor-pointer hover:bg-white/5" : ""}`}
        onClick={() => hasContent && setExpanded((v) => !v)}
      >
        {/* Diamond icon */}
        <svg width="11" height="11" viewBox="0 0 14 14" className="flex-shrink-0 text-indigo-400/80" fill="currentColor">
          <path d="M7 0L9.5 4.5L14 7L9.5 9.5L7 14L4.5 9.5L0 7L4.5 4.5L7 0Z" />
        </svg>

        <span className="text-white/35 font-normal">Call</span>

        <code className="px-1.5 py-0.5 rounded bg-white/8 border border-white/10 font-mono text-[11px] text-white/80">
          {step.toolName === "batch_commit" ? "batch_apply" : step.toolName.split(".").pop()}
        </code>

        <span className="text-white/35">from</span>

        <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/8 text-[10px] text-white/55 font-medium tracking-wide">
          {step.server}
        </span>

        {/* File path hint — shows next to server label when we have metadata */}
        {step.filePath && !expanded && (
          <span className="text-[10px] text-white/30 font-mono truncate max-w-[140px]" title={step.filePath}>
            {step.filePath.split("/").pop()}
          </span>
        )}

        {/* Status badge */}
        <span className={`ml-auto flex-shrink-0 flex items-center gap-1 font-medium ${step.ok ? "text-emerald-400/80" : "text-red-400/80"}`}>
          {step.ok ? (
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M3.5 6L5.2 7.7L8.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M4 4L8 8M8 4L4 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          )}
          <span className="text-[10px]">{step.ok ? "Done" : "Failed"}</span>
        </span>

        {hasContent && (
          <span
            className="ml-1 text-white/25 text-[10px] transition-transform duration-150"
            style={{ display: "inline-block", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            ∨
          </span>
        )}
      </div>

      {/* ── Expanded detail ─────────────────────────────────────────────────── */}
      {expanded && hasContent && (
        <div className="border-t border-white/6">

          {/* File content preview — the key new feature: see what was actually written */}
          {step.contentPreview && (
            <div className="p-2.5">
              <div className="flex items-center justify-between mb-1.5 px-0.5">
                <div className="flex items-center gap-2">
                  {step.filePath && (
                    <span className="text-[10px] font-mono text-white/45 truncate max-w-[240px]">
                      {step.filePath}
                    </span>
                  )}
                  <span className="text-[9px] text-white/25 uppercase tracking-widest">{lang}</span>
                  {step.truncated && (
                    <span className="text-[9px] text-amber-400/60">
                      (showing first 2000 of {step.contentLength?.toLocaleString()} chars)
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="text-[10px] px-2 py-0.5 rounded bg-white/8 hover:bg-white/12 border border-white/10 text-white/50"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await copyText(step.contentPreview!)) {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    }
                  }}
                  aria-label="Copy file content to clipboard"
                  title="Copy file content"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <pre className="text-[10.5px] leading-relaxed bg-black/40 border border-white/8 rounded-md p-3 overflow-x-auto overflow-y-auto max-h-64 whitespace-pre text-white/70 font-mono">
                <code>{step.contentPreview}</code>
              </pre>
            </div>
          )}

          {/* Batch commit — list of written files */}
          {step.files && step.files.length > 0 && (
            <div className="px-3 py-2.5">
              <div className="text-[10px] text-white/35 uppercase tracking-widest mb-1.5">Files written</div>
              <div className="space-y-1">
                {step.files.map((f) => (
                  <div key={f} className="flex items-center gap-1.5 text-[11px] font-mono text-white/55">
                    <span className="text-emerald-400/60">✓</span>
                    <span className="truncate">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Plain summary detail (no content preview available) */}
          {!step.contentPreview && !(step.files && step.files.length > 0) && (
            <div className="px-3 py-2.5">
              <p className="text-[11px] text-white/50 leading-relaxed">{step.summary}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tool actions block ────────────────────────────────────────────────────────

function ToolActionsBlock({ steps }: { steps: ActionStep[] }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-3">
      {/* Header row */}
      <button
        className="flex items-center gap-1.5 text-[11px] text-white/35 hover:text-white/55 mb-2 transition-colors"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span
          className="text-[10px] transition-transform duration-150"
          style={{ display: "inline-block", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
        >
          ∨
        </span>
        <span className="font-medium uppercase tracking-widest text-[10px]">
          {steps.length} action{steps.length !== 1 ? "s" : ""}
        </span>
        <span className="text-white/20">·</span>
        <span className={steps.every((s) => s.ok) ? "text-emerald-400/60" : "text-amber-400/60"}>
          {steps.filter((s) => s.ok).length}/{steps.length} succeeded
        </span>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-1.5">
          {steps.map((step, i) => <ToolStepCard key={i} step={step} />)}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChatCenter({
  chat,
  onSend,
  isStreaming,
  isThinking,
  onStop,
  onRegenerate,
  canRegenerate,
  onClearStatus,
  agentStatus = "",
  onUpdateSystemPrompt,
}: Props) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // ── V3: Image attachments ───────────────────────────────────────────────────
  // pendingImages: base64 strings (no data: prefix — Ollama wants raw base64)
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── V4-A: PDF attachments ───────────────────────────────────────────────────
  const [pendingPdfs, setPendingPdfs] = useState<PendingPdf[]>([]);
  const [pdfLoading, setPdfLoading] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);

  // ── V3: System prompt editor ────────────────────────────────────────────────
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = useState("");

  // Sync draft when chat changes
  useEffect(() => {
    setSystemPromptDraft((chat as any)?.systemPrompt ?? "");
    setSystemPromptOpen(false);
  }, [chat?.id]);

  // ── Context meter ───────────────────────────────────────────────────────────
  // Rough estimate: chars / 4 ≈ tokens. Warn at 6k, danger at 10k.
  const estimatedTokens = Math.floor(
    (chat?.messages || []).reduce((acc, m) => acc + (m.content?.length ?? 0), 0) / 4
  );
  const ctxColor =
    estimatedTokens > 10000 ? "text-red-400" :
    estimatedTokens > 6000  ? "text-amber-400" :
    "text-white/30";

  // ── Live tool progress ──────────────────────────────────────────────────────
  // Subscribes to mcp://tool-progress events emitted by mcp.rs when
  // mcp_call_tool starts and finishes. Shows instant feedback while a tool
  // is executing instead of N seconds of silence.
  const [liveToolName, setLiveToolName] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri || !tauriListen) return;
    let unlisten: (() => void) | null = null;

    tauriListen<{ phase: string; tool: string; ok?: boolean; ts: number }>(
      "mcp://tool-progress",
      (event) => {
        const { phase, tool } = event.payload;
        if (phase === "start") setLiveToolName(tool);
        else if (phase === "done") setLiveToolName(null);
      }
    ).then((fn) => { unlisten = fn; }).catch(() => {});

    return () => { unlisten?.(); };
  }, []);

  const { mcpState, tools, error, connected, connect, refreshTools } = useMcp();
  const mcpConnected = mcpState === "connected";
  const toolCount = tools.length > 0 ? tools.length : null;

  const [mcpReconnectBusy, setMcpReconnectBusy] = useState(false);
  const [mcpReconnectErr, setMcpReconnectErr] = useState<string | null>(null);
  const [mcpDegraded, setMcpDegraded] = useState(false);
  const [mcpLastErr, setMcpLastErr] = useState<string | null>(null);
  const mcpFailRef = useRef<number>(0);

  const reconnectMcp = async () => {
    setMcpReconnectBusy(true);
    setMcpReconnectErr(null);
    setMcpLastErr(null);
    setMcpDegraded(false);
    mcpFailRef.current = 0;
    try {
      const raw = localStorage.getItem("nikolai.mcp.stdio.v1");
      if (!raw) throw new Error("No MCP config saved. Open Tools tab → Connect once.");
      const cfg = JSON.parse(raw);
      const command = String(cfg?.command || "").trim();
      if (!command) throw new Error("MCP config missing command. Tools tab → Connect once.");
      const cwd = cfg?.cwd?.trim() || null;
      let argsArr: string[] = [];
      if (Array.isArray(cfg?.args)) {
        argsArr = cfg.args.map((x: any) => String(x)).filter(Boolean);
      } else if (typeof cfg?.args === "string") {
        argsArr = cfg.args.trim().split(/\s+/).filter(Boolean);
      }
      await connect({ command, args: argsArr, cwd });
    } catch (e: any) {
      setMcpReconnectErr(e?.message || String(e));
    } finally {
      setMcpReconnectBusy(false);
    }
  };

  useEffect(() => {
    if (error) {
      mcpFailRef.current += 1;
      setMcpLastErr(error);
      if (mcpFailRef.current >= 3) setMcpDegraded(true);
    } else if (connected) {
      setMcpLastErr(null);
      setMcpDegraded(false);
      mcpFailRef.current = 0;
    }
  }, [error, connected]);

  useEffect(() => {
    atBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [chat?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chat?.messages.length]);

  useEffect(() => {
    if (!isStreaming) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const el = scrollRef.current;
      if (el && atBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isStreaming]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = atBottom;
    setShowJumpToBottom((prev) => (prev !== !atBottom ? !atBottom : prev));
  };

  if (!chat) {
    return <div className="h-full flex items-center justify-center text-sm opacity-70">Create a chat from the left panel.</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* ── Header ── */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className="font-semibold truncate max-w-[240px]">{chat.title}</div>
          {/* System prompt gear */}
          <button
            type="button"
            title="Edit system prompt for this chat"
            className={`text-[11px] px-1.5 py-0.5 rounded border transition-colors ${
              (chat as any).systemPrompt
                ? "border-indigo-400/40 bg-indigo-500/15 text-indigo-300/80 hover:bg-indigo-500/25"
                : "border-white/10 bg-white/5 text-white/30 hover:text-white/60"
            }`}
            onClick={() => setSystemPromptOpen((v) => !v)}
          >
            ⚙
          </button>
        </div>
        <div className="text-xs flex items-center gap-2">
          {/* Context meter */}
          <span className={`font-mono text-[10px] ${ctxColor}`} title="Estimated context tokens (chars÷4)">
            ~{estimatedTokens > 1000 ? `${(estimatedTokens / 1000).toFixed(1)}k` : estimatedTokens}t
          </span>
          {isStreaming ? <span className="text-green-300">• streaming</span> : <span className="text-white/30">idle</span>}
          <span className={`px-2 py-0.5 rounded border border-white/10 ${mcpConnected ? "bg-white/10" : ""}`}>
            MCP: {mcpState}
          </span>
          {(mcpState !== "connected" || mcpDegraded) && (
            <button
              type="button"
              className="px-2 py-0.5 rounded border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-50"
              onClick={reconnectMcp}
              disabled={mcpReconnectBusy}
              title={mcpReconnectErr || mcpLastErr || "Reconnect MCP"}
            >
              {mcpReconnectBusy ? "Reconnecting…" : "Reconnect"}
            </button>
          )}
          <span className="px-2 py-0.5 rounded border border-white/10 bg-white/5">
            {toolCount === null ? "—" : toolCount} tools
          </span>
          {mcpConnected && (
            <button type="button" className="px-2 py-0.5 rounded border border-white/10 bg-white/5 hover:bg-white/10" onClick={refreshTools}>
              Refresh
            </button>
          )}
          <button
            type="button"
            className="px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/10"
            onClick={() => {
              const safeTitle = (chat.title || "chat").replace(/[\\\/:*?"<>|]+/g, "_").trim() || "chat";
              const ts = new Date().toISOString().replace(/[:.]/g, "-");
              downloadMarkdown(`${safeTitle}_${ts}.md`, [
                `# ${chat.title || "Chat"}`, "",
                ...chat.messages.map((m) => `## ${m.role === "user" ? "User" : "Assistant"}\n\n${String(m.content || "")}\n`),
              ].join("\n"));
            }}
          >
            Export
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/10"
            onClick={() => onClearStatus?.()}
          >
            Clear
          </button>
        </div>
      </div>

      {/* ── System prompt editor (collapsible) ── */}
      {systemPromptOpen && (
        <div className="border-b border-white/10 bg-white/[0.02] px-4 py-3 space-y-2">
          <div className="text-[11px] text-white/50 font-medium uppercase tracking-widest">
            System prompt — {chat.title}
          </div>
          <textarea
            className="w-full min-h-[80px] rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30 font-mono resize-y"
            placeholder="e.g. You are NikolAi, a local AI assistant. Be concise and precise."
            value={systemPromptDraft}
            onChange={(e) => setSystemPromptDraft(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold"
              onClick={() => {
                onUpdateSystemPrompt?.(chat.id, systemPromptDraft.trim());
                setSystemPromptOpen(false);
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 border border-white/10 text-xs"
              onClick={() => setSystemPromptOpen(false)}
            >
              Cancel
            </button>
            {(chat as any).systemPrompt && (
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 text-xs text-red-300/80"
                onClick={() => {
                  onUpdateSystemPrompt?.(chat.id, "");
                  setSystemPromptDraft("");
                  setSystemPromptOpen(false);
                }}
              >
                Clear prompt
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto p-4 space-y-6 relative"
      >
        {chat.messages.map((m, idx) => (
          <MessageBubble
            key={m.id}
            m={m}
            isLast={idx === chat.messages.length - 1}
            canRegenerate={!!canRegenerate}
            onRegenerate={onRegenerate}
          />
        ))}
        {isThinking && (
          <div className="flex items-center gap-2 px-2 py-3 text-white/40 text-sm">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:300ms]" />
            </span>
            <span>NikolAI is thinking…</span>
          </div>
        )}
        <div ref={endRef} />
        {showJumpToBottom && (
          <button
            type="button"
            className="absolute bottom-4 right-4 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-xs"
            onClick={() => {
              const el = scrollRef.current;
              atBottomRef.current = true;
              setShowJumpToBottom(false);
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            }}
          >
            Jump to bottom
          </button>
        )}
      </div>

      {/* ── Priority 4: Floating agent status + live tool progress ── */}
      {(agentStatus || liveToolName) && isStreaming && (
        <div className="mx-3 mb-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 space-y-1.5">
          {agentStatus && (
            <div className="flex items-center gap-2.5">
              <span className="h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 border-white/20 border-t-white/80 animate-spin" />
              <span className="text-xs text-white/75 leading-snug">{agentStatus}</span>
            </div>
          )}
          {liveToolName && (
            <div className="flex items-center gap-2.5">
              {/* Pulsing dot — distinct from the planning spinner above */}
              <span className="h-2 w-2 flex-shrink-0 rounded-full bg-indigo-400/70 animate-pulse" />
              <span className="text-[11px] text-white/50 leading-snug font-mono truncate">
                {liveToolName}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Input ── */}
      <div className="border-t border-white/10 p-3 space-y-2">

        {/* ── Pending PDF pills ── */}
        {pendingPdfs.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingPdfs.map((pdf, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-amber-400/25 bg-amber-500/10 text-[11px]">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400/70 flex-shrink-0">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                </svg>
                <span className="text-amber-200/80 truncate max-w-[120px]">{pdf.name}</span>
                <span className="text-amber-400/50">{pdf.pages}p</span>
                <button
                  type="button"
                  className="text-amber-400/60 hover:text-red-400/80 ml-0.5"
                  onClick={() => setPendingPdfs((prev) => prev.filter((_, j) => j !== i))}
                >×</button>
              </div>
            ))}
          </div>
        )}

        {/* ── Pending image thumbnails ── */}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingImages.map((b64, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:image/jpeg;base64,${b64}`}
                  alt={`attachment ${i + 1}`}
                  className="h-16 w-16 object-cover rounded-lg border border-white/15"
                />
                <button
                  type="button"
                  className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-black/80 border border-white/20 text-[9px] text-white/80 flex items-center justify-center hover:bg-red-900/80 transition-colors"
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  title="Remove image"
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          {/* Hidden image file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              const b64s = await Promise.all(files.map(fileToBase64));
              setPendingImages((prev) => [...prev, ...b64s]);
              e.target.value = "";
            }}
          />

          {/* Hidden PDF file input */}
          <input
            ref={pdfInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              if (!files.length) return;
              setPdfLoading(true);
              try {
                const extracted = await Promise.all(files.map(extractPdfText));
                setPendingPdfs((prev) => [...prev, ...extracted]);
              } catch (err: any) {
                console.error("PDF extraction failed:", err);
              } finally {
                setPdfLoading(false);
                e.target.value = "";
              }
            }}
          />

          {/* Paperclip — image */}
          <button
            type="button"
            title="Attach image (or paste / drag-drop)"
            className="flex-shrink-0 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 py-2 text-white/50 hover:text-white/80 transition-colors disabled:opacity-40"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>

          {/* PDF button */}
          <button
            type="button"
            title="Attach PDF document"
            className={`flex-shrink-0 rounded-md border px-2.5 py-2 transition-colors disabled:opacity-40 ${
              pdfLoading
                ? "border-amber-400/30 bg-amber-500/10 text-amber-400/60"
                : "bg-white/5 hover:bg-white/10 border-white/10 text-white/50 hover:text-amber-300/80"
            }`}
            onClick={() => pdfInputRef.current?.click()}
            disabled={isStreaming || pdfLoading}
          >
            {pdfLoading ? (
              <span className="text-[10px] font-mono">reading…</span>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
            )}
          </button>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="Type a message… (Ctrl+V to paste an image, drag PDF here)"
            className="flex-1 resize-none rounded-md bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                const hasPdfs   = pendingPdfs.length > 0;
                const hasImages = pendingImages.length > 0;
                const t = text.trim();
                if (!t && !hasPdfs && !hasImages) return;
                const pdfPrefix = hasPdfs ? pendingPdfs.map(formatPdfBlock).join("") : "";
                onSend(pdfPrefix + t, hasImages ? pendingImages : undefined);
                setText("");
                setPendingImages([]);
                setPendingPdfs([]);
              }
            }}
            onPaste={async (e) => {
              const imgs = await extractImagesFromDataTransfer(e.clipboardData);
              if (imgs.length > 0) {
                e.preventDefault();
                setPendingImages((prev) => [...prev, ...imgs]);
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              // Handle image drops
              const imgs = await extractImagesFromDataTransfer(e.dataTransfer);
              if (imgs.length > 0) {
                setPendingImages((prev) => [...prev, ...imgs]);
                return;
              }
              // Handle PDF drops
              const pdfFiles = Array.from(e.dataTransfer.files).filter(
                (f) => f.type === "application/pdf" || f.name.endsWith(".pdf")
              );
              if (pdfFiles.length > 0) {
                setPdfLoading(true);
                try {
                  const extracted = await Promise.all(pdfFiles.map(extractPdfText));
                  setPendingPdfs((prev) => [...prev, ...extracted]);
                } finally {
                  setPdfLoading(false);
                }
              }
            }}
            disabled={isStreaming}
          />

          {!isStreaming ? (
            <button
              type="button"
              className="rounded-md bg-blue-600 hover:bg-blue-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
              onClick={() => {
                const hasPdfs   = pendingPdfs.length > 0;
                const hasImages = pendingImages.length > 0;
                const t = text.trim();
                if (!t && !hasPdfs && !hasImages) return;
                const pdfPrefix = hasPdfs ? pendingPdfs.map(formatPdfBlock).join("") : "";
                onSend(pdfPrefix + t, hasImages ? pendingImages : undefined);
                setText("");
                setPendingImages([]);
                setPendingPdfs([]);
              }}
              disabled={!text.trim() && pendingImages.length === 0 && pendingPdfs.length === 0}
            >
              Send
            </button>
          ) : (
            <button type="button" className="rounded-md bg-amber-600 hover:bg-amber-500 px-4 py-2 text-sm font-semibold" onClick={onStop}>
              Stop
            </button>
          )}
        </div>

        {/* Atelier NikolAi wordmark */}
        <div className="text-right text-[9px] text-white/15 font-light tracking-widest select-none pr-1">
          ATELIER NIKOLAI DESKTOP
        </div>
      </div>
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({
  m,
  isLast,
  canRegenerate,
  onRegenerate,
}: {
  m: Message;
  isLast: boolean;
  canRegenerate: boolean;
  onRegenerate?: () => void;
}) {
  const isUser = m.role === "user";

  // Legacy __STATUS__: support (old saved chats)
  const isLegacyStatus = !isUser && typeof m.content === "string" && m.content.startsWith("__STATUS__:");
  const legacyStatusText = isLegacyStatus ? m.content.replace("__STATUS__:", "").trim() : "";

  let content = sanitizeLegacyStatusLines(String(m.content || ""));
  if (!isUser && !isLegacyStatus) content = guardIdentityDisplay(content);

  // ── Tool action card parsing ───────────────────────────────────────────────
  // Detect the "**Actions taken:**" block that agentic.ts prepends before the
  // final answer. If found, split the message into:
  //   - Visual tool step cards (rendered as ToolActionsBlock)
  //   - Plain answer text (rendered as Markdown below the cards)
  //
  // Plain chat messages (no Actions block) render exactly as before.
  const parsed = !isUser && !isLegacyStatus ? parseAgentMessage(content) : null;

  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && <Avatar kind="assistant" />}

      <div
        className={`group max-w-[70%] rounded-2xl px-5 py-4 border relative ${
          isUser ? "bg-blue-600/20 border-blue-500/30" : "bg-white/5 border-white/10"
        }`}
      >
        {!isLegacyStatus && (
          <div className="absolute top-2 right-2 flex gap-2">
            <button
              className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/10"
              onClick={() => copyText(content)}
              aria-label="Copy message to clipboard"
              title="Copy message"
            >
              Copy
            </button>
            {!isUser && isLast && canRegenerate && onRegenerate && (
              <button
                className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/10"
                onClick={onRegenerate}
                aria-label="Regenerate response"
                title="Regenerate response"
              >
                Regen
              </button>
            )}
          </div>
        )}

        {isLegacyStatus ? (
          // Old saved chats that have __STATUS__: in content
          <div className="inline-flex items-center gap-2 text-xs opacity-85">
            <span className="h-3 w-3 rounded-full border border-white/30 border-t-white/80 animate-spin" />
            <span>{legacyStatusText || "Working..."}</span>
          </div>

        ) : parsed ? (
          // ── Agent message: tool cards + answer ──────────────────────────────
          <div className="text-sm pr-14">
            {/* Tool step cards */}
            <ToolActionsBlock steps={parsed.steps} />

            {/* Divider between cards and answer */}
            {parsed.answerText && (
              <div className="border-t border-white/8 pt-3 mt-1">
                <Md text={parsed.answerText} />
              </div>
            )}

            <div className="mt-3 pt-2 border-t border-white/5 text-[10px] opacity-40 text-right">
              {new Date(m.ts).toLocaleTimeString()}
            </div>
          </div>

        ) : (
          // ── Plain message (user or plain assistant) ───────────────────────
          <>
            {/* ── V3: Image thumbnails in message ── */}
            {m.images && m.images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {m.images.map((b64, i) => (
                  <img
                    key={i}
                    src={`data:image/jpeg;base64,${b64}`}
                    alt={`image ${i + 1}`}
                    className="max-h-48 max-w-full rounded-lg border border-white/15 object-contain"
                  />
                ))}
              </div>
            )}
            <div className="text-sm pr-14">
              {isUser ? (
                <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
              ) : (
                <Md text={content} />
              )}
            </div>
            <div className="mt-3 pt-2 border-t border-white/5 text-[10px] opacity-40 text-right">
              {new Date(m.ts).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>

      {isUser && <Avatar kind="user" />}
    </div>
  );
}
