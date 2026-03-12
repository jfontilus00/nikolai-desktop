import { useState, useEffect } from "react";

type Props = {
  open: boolean;
  toolName: string;
  toolArgs: any;
  onDeny: () => void;
  onAllowOnce: () => void;
  onAllowChat: () => void;
};

// Derive the server name from the tool name prefix — matches how mcp-hub names tools
function serverFromTool(name: string): string {
  if (name.startsWith("fs."))            return "FS";
  if (name.startsWith("doc-suite."))     return "DOC-SUITE";
  if (name.startsWith("hub."))           return "HUB";
  if (name.startsWith("project-brain.")) return "PROJECT-BRAIN";
  const parts = name.split(".");
  return parts.length > 1 ? parts[0].toUpperCase() : "MCP";
}

// Bare tool name without server prefix — e.g. "fs.read_file" → "read_file"
function bareToolName(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1] ?? name;
}

export default function ToolApprovalModal({
  open,
  toolName,
  toolArgs,
  onDeny,
  onAllowOnce,
  onAllowChat,
}: Props) {
  const [argsExpanded, setArgsExpanded] = useState(false);

  // Close modal on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDeny();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onDeny]);

  if (!open) return null;

  const server = serverFromTool(toolName);
  const bareName = bareToolName(toolName);
  const hasArgs = toolArgs && Object.keys(toolArgs).length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tool-approval-title"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-lg rounded-2xl bg-[#0e1117] border border-white/10 shadow-2xl overflow-hidden">

        {/* ── Tool call header ── */}
        <div className="px-5 py-3.5 border-b border-white/8 bg-white/[0.02]">
          <div className="flex items-center gap-2 text-[13px]">
            {/* Diamond icon matching image 2 */}
            <svg
              width="14" height="14" viewBox="0 0 14 14"
              className="flex-shrink-0 text-indigo-400"
              fill="currentColor"
            >
              <path d="M7 0L9.5 4.5L14 7L9.5 9.5L7 14L4.5 9.5L0 7L4.5 4.5L7 0Z" />
            </svg>

            <span className="text-white/40 font-normal">Call</span>

            <code className="px-2 py-0.5 rounded-md bg-white/8 border border-white/10 font-mono text-[12px] text-white/90 leading-relaxed">
              {bareName}
            </code>

            <span className="text-white/40 font-normal">from</span>

            <span className="px-1.5 py-0.5 rounded bg-white/6 text-[11px] font-medium text-white/65 tracking-wide">
              {server}
            </span>

            {/* Expand/collapse args toggle — matching the "..." and chevron in image 2 */}
            {hasArgs && (
              <button
                type="button"
              className="ml-auto flex items-center gap-1 text-white/30 hover:text-white/60 transition-colors"
                onClick={() => setArgsExpanded((v) => !v)}
              >
                <span className="text-[11px]">···</span>
                <span
                  className="text-[11px] transition-transform duration-150"
                  style={{ display: "inline-block", transform: argsExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
                >
                  ∨
                </span>
              </button>
            )}
          </div>

          {/* Expandable args panel */}
          {argsExpanded && hasArgs && (
            <div className="mt-3 rounded-lg bg-black/30 border border-white/8 p-3 max-h-40 overflow-auto">
              <pre className="text-[11px] text-white/65 whitespace-pre-wrap break-words leading-relaxed">
                {JSON.stringify(toolArgs, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* ── Permission card body ── */}
        <div className="px-5 py-5">
          <div id="tool-approval-title" className="text-[14px] font-semibold text-white/90 mb-1.5">
            Allow{" "}
            <span className="font-mono text-[13px] bg-white/8 border border-white/10 rounded px-1.5 py-0.5 text-white/80">
              {bareName}
            </span>{" "}
            (local) to run?
          </div>

          <div className="text-[12px] text-white/45 leading-relaxed mb-5">
            Tool calls can access local files and system resources. Review arguments
            carefully before approving — malicious MCP servers may perform harmful actions.
          </div>

          {/* Args preview (always visible, compact) */}
          {hasArgs && (
            <div className="mb-5 rounded-xl bg-white/4 border border-white/8 p-3.5 max-h-52 overflow-auto">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-white/30 mb-2">
                Arguments
              </div>
              <pre className="text-[12px] text-white/70 whitespace-pre-wrap break-words leading-relaxed">
                {JSON.stringify(toolArgs, null, 2)}
              </pre>
            </div>
          )}

          {/* ── Action buttons — matching image 2 layout exactly ── */}
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
            className="px-4 py-2.5 rounded-xl border border-white/10 text-[13px] text-white/55 hover:bg-white/5 hover:text-white/80 transition-colors"
              onClick={onDeny}
            >
              Deny
            </button>

            <div className="flex gap-2.5">
              <button
                type="button"
              className="px-4 py-2.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-[13px] text-white/75 transition-colors"
                onClick={onAllowOnce}
              >
                Allow once
              </button>

              <button
                type="button"
              className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-[13px] font-semibold text-white transition-colors shadow-lg shadow-indigo-900/40"
                onClick={onAllowChat}
              >
                Allow in this chat
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}