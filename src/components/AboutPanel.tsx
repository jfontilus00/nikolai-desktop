import { APP_NAME, APP_AUTHOR, APP_VERSION } from "../lib/appMeta";

export default function AboutPanel() {
  return (
    <div className="p-3 space-y-3">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-lg font-semibold">{APP_NAME}</div>
        <div className="text-xs opacity-70 mt-1">made by {APP_AUTHOR}</div>

        <div className="mt-3 text-sm">
          <div className="flex items-center justify-between border-b border-white/10 py-2">
            <span className="opacity-80">Version</span>
            <span className="font-mono text-xs">{APP_VERSION}</span>
          </div>
          <div className="flex items-center justify-between border-b border-white/10 py-2">
            <span className="opacity-80">Mode</span>
            <span className="text-xs opacity-80">Local (Ollama + MCP Hub)</span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="opacity-80">Build</span>
            <span className="text-xs opacity-80">0.1.x beta</span>
          </div>
        </div>

        <div className="mt-3 text-xs opacity-70">
          Tip: Use the Tools tab to connect MCP and list tools. Agentic tool calls always require approval.
        </div>
      </div>
    </div>
  );
}