import { useEffect, useMemo, useRef, useState } from "react";
import WorkspacePanel from "./WorkspacePanel";
import { uid } from "../lib/id";
import {
  loadMcpProfiles,
  saveMcpProfiles,
  loadActiveMcpProfileId,
  saveActiveMcpProfileId,
  type McpProfile,
  loadToolLog,
} from "../lib/storage";
import { useMcp, setAutoReconnectCallback, type McpTool } from "../lib/mcp";

type Props = {
  onInsertToComposer?: (text: string) => void;
};

// ── Shell-style arg splitter ──────────────────────────────────────────────────
function splitArgs(input: string): string[] {
  const s = String(input || "").trim();
  if (!s) return [];
  const out: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === "\\" && i + 1 < s.length) { cur += s[i + 1]; i++; continue; }
      if (ch === q) { q = null; continue; }
      cur += ch; continue;
    }
    if (ch === '"' || ch === "'") { q = ch as any; continue; }
    if (/\s/.test(ch)) { if (cur.length) { out.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ── Uptime display ────────────────────────────────────────────────────────────
function useUptime(connectedAt: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!connectedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [connectedAt]);

  if (!connectedAt) return "";
  const secs = Math.floor((Date.now() - connectedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

// ── Group tools by namespace prefix (before first dot) ────────────────────────
function groupTools(tools: string[], toolsRaw: McpTool[]): Map<string, McpTool[]> {
  const descMap = new Map(toolsRaw.map((t) => [t.name, t]));
  const groups = new Map<string, McpTool[]>();

  for (const name of tools) {
    const dot = name.indexOf(".");
    const ns = dot > 0 ? name.slice(0, dot) : "general";
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(descMap.get(name) ?? { name });
  }

  // Sort groups: general first, then alphabetical
  const sorted = new Map<string, McpTool[]>();
  const keys = [...groups.keys()].sort((a, b) =>
    a === "general" ? -1 : b === "general" ? 1 : a.localeCompare(b)
  );
  for (const k of keys) sorted.set(k, groups.get(k)!);
  return sorted;
}

// ── Status dot ────────────────────────────────────────────────────────────────
function StatusDot({ state }: { state: string }) {
  const color =
    state === "connected"   ? "bg-green-400" :
    state === "connecting"  ? "bg-yellow-400 animate-pulse" :
    state === "error"       ? "bg-red-400" :
                              "bg-white/30";
  return <span className={`inline-block w-2 h-2 rounded-full ${color} flex-shrink-0`} />;
}

// ── Tool button with tooltip ──────────────────────────────────────────────────
function ToolButton({ tool, onClick }: { tool: McpTool; onClick: () => void }) {
  const [tip, setTip] = useState(false);
  const shortName = tool.name.includes(".") ? tool.name.split(".").slice(1).join(".") : tool.name;

  return (
    <div className="relative">
      <button
        className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 border border-white/10 text-xs transition-colors"
        onClick={onClick}
        onMouseEnter={() => setTip(true)}
        onMouseLeave={() => setTip(false)}
      >
        {shortName}
      </button>
      {tip && tool.description && (
        <div className="absolute bottom-full left-0 mb-1 z-50 w-56 bg-black/90 border border-white/20 rounded p-2 text-[11px] opacity-90 pointer-events-none shadow-lg">
          <div className="font-semibold text-white/90 mb-0.5">{tool.name}</div>
          <div className="text-white/60 leading-snug">{tool.description}</div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ToolsPanel({ onInsertToComposer }: Props) {
  const [subtab, setSubtab] = useState<"mcp" | "workspace">("mcp");
  const [configOpen, setConfigOpen] = useState(false);
  const [toolSearch, setToolSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // MCP profiles
  const [profiles, setProfiles] = useState<McpProfile[]>(() => loadMcpProfiles());
  const [activeId, setActiveId] = useState<string | null>(() => loadActiveMcpProfileId());

  const {
    mcpState, tools, toolsRaw, error, loading, toolsLoading,
    connected, connectedAt, connect, disconnect, refreshTools,
  } = useMcp();

  const uptime = useUptime(connectedAt);
  const activeProfile = profiles.find((p) => p.id === activeId) || null;
  const didAutoConnect = useRef(false);

  // ── Ensure at least one profile ──
  useEffect(() => {
    if (profiles.length === 0) {
      const p: McpProfile = { id: uid("mcp"), name: "Default MCP", command: "", args: "", cwd: "", autoConnect: true, createdAt: Date.now(), updatedAt: Date.now() };
      const next = [p];
      setProfiles(next);
      setActiveId(p.id);
      saveMcpProfiles(next);
      saveActiveMcpProfileId(p.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist activeId ──
  useEffect(() => {
    if (activeId) saveActiveMcpProfileId(activeId);
  }, [activeId]);

  // ── Auto-reconnect on startup ──
  useEffect(() => {
    if (didAutoConnect.current) return;
    if (!activeProfile?.command || !activeProfile.autoConnect) return;
    if (mcpState !== "disconnected") return;

    didAutoConnect.current = true;

    const args = splitArgs(activeProfile.args || "");
    const cfg = { command: activeProfile.command, args, cwd: activeProfile.cwd || null };

    // Register reconnect callback for unexpected drops
    setAutoReconnectCallback(() => {
      console.log("[ToolsPanel] auto-reconnect triggered");
      connect(cfg).catch(() => {/* handled by store error */});
    });

    console.log("[ToolsPanel] auto-connecting on startup...");
    connect(cfg).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, mcpState]);

  // ── Collapse config when connected ──
  useEffect(() => {
    if (connected) setConfigOpen(false);
    if (mcpState === "disconnected" || mcpState === "error") setConfigOpen(true);
  }, [connected, mcpState]);

  // ── Profile helpers ──
  function updateProfile(patch: Partial<McpProfile>) {
    if (!activeProfile) return;
    const next = profiles.map((p) => (p.id === activeProfile.id ? { ...p, ...patch } : p));
    setProfiles(next);
    saveMcpProfiles(next);
  }
  function createProfile() {
    const name = prompt("New MCP profile name", "New MCP");
    if (!name) return;
    const p: McpProfile = { id: uid("mcp"), name, command: "", args: "", cwd: "", autoConnect: true, createdAt: Date.now(), updatedAt: Date.now() };
    const next = [p, ...profiles];
    setProfiles(next);
    setActiveId(p.id);
    saveMcpProfiles(next);
    saveActiveMcpProfileId(p.id);
  }
  function renameProfile() {
    if (!activeProfile) return;
    const name = prompt("Rename MCP profile", activeProfile.name);
    if (!name) return;
    updateProfile({ name });
  }
  function deleteProfile() {
    if (!activeProfile) return;
    if (!confirm(`Delete MCP profile "${activeProfile.name}"?`)) return;
    const next = profiles.filter((p) => p.id !== activeProfile.id);
    setProfiles(next);
    saveMcpProfiles(next);
    const nextActive = next[0]?.id ?? null;
    setActiveId(nextActive);
    saveActiveMcpProfileId(nextActive);
  }

  async function handleConnect() {
    if (!activeProfile) return;
    const args = splitArgs(activeProfile.args || "");
    const cfg = { command: activeProfile.command, args, cwd: activeProfile.cwd || null };

    // Register reconnect callback
    setAutoReconnectCallback(() => connect(cfg).catch(() => {}));
    await connect(cfg);
  }

  async function handleDisconnect() {
    // Pass true = user-initiated, suppress auto-reconnect
    await disconnect(true);
    didAutoConnect.current = false;
  }

  // ── Tool filtering + grouping ──
  const filteredTools = useMemo(() => {
    const q = toolSearch.trim().toLowerCase();
    return q ? tools.filter((t) => t.toLowerCase().includes(q)) : tools;
  }, [tools, toolSearch]);

  const groupedTools = useMemo(
    () => groupTools(filteredTools, toolsRaw),
    [filteredTools, toolsRaw]
  );

  function toggleGroup(ns: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.has(ns) ? next.delete(ns) : next.add(ns);
      return next;
    });
  }

  const toolLog = useMemo(
    () => loadToolLog().slice(-40).reverse(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mcpState, error, connected, tools.length]
  );

  // ── Status label ──
  const statusLabel =
    mcpState === "connected"  ? `connected · ${tools.length} tools${uptime ? ` · ${uptime}` : ""}` :
    mcpState === "connecting" ? "connecting…" :
    mcpState === "error"      ? "error" :
    "disconnected";

  return (
    <div className="h-full flex flex-col text-sm">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5 flex-shrink-0">
        {(["mcp", "workspace"] as const).map((tab) => (
          <button
            key={tab}
            className={`px-3 py-1.5 rounded text-xs font-medium capitalize transition-colors ${
              subtab === tab ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80 hover:bg-white/8"
            }`}
            onClick={() => setSubtab(tab)}
          >
            {tab}
            {tab === "mcp" && tools.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-blue-500/30 text-blue-300 text-[10px]">
                {tools.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {subtab === "workspace" && (
        <div className="flex-1 overflow-auto">
          <WorkspacePanel />
        </div>
      )}

      {subtab === "mcp" && (
        <div className="flex-1 overflow-auto p-3 space-y-3">

          {/* ── Status bar ── */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusDot state={mcpState} />
              <span className="text-xs text-white/70">{statusLabel}</span>
            </div>
            {connected && (
              <div className="flex items-center gap-1.5">
                <button
                  className="text-[11px] px-2 py-1 rounded bg-white/8 hover:bg-white/15 border border-white/10 text-white/60 transition-colors"
                  onClick={refreshTools}
                  disabled={toolsLoading}
                  title="Refresh tool list"
                >
                  {toolsLoading ? "↻ loading…" : "↻ refresh"}
                </button>
                <button
                  className="text-[11px] px-2 py-1 rounded bg-white/8 hover:bg-white/15 border border-white/10 text-white/60 transition-colors"
                  onClick={handleDisconnect}
                  disabled={loading}
                >
                  disconnect
                </button>
              </div>
            )}
          </div>

          {/* ── Error banner ── */}
          {error && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-900/20 border border-red-500/30 rounded p-2">
              <span className="flex-shrink-0 mt-0.5">⚠</span>
              <span className="break-all">{error}</span>
            </div>
          )}

          {/* ── Config panel (collapsible) ── */}
          <div className="border border-white/10 rounded-lg bg-white/5">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-white/70 hover:text-white/90 transition-colors"
              onClick={() => setConfigOpen((v) => !v)}
            >
              <span>
                {activeProfile?.name || "Profile"}
                {activeProfile?.command && (
                  <span className="ml-2 font-normal text-white/40 text-[11px]">
                    {activeProfile.command.split(/[\\/]/).pop()}
                  </span>
                )}
              </span>
              <span className="text-white/30 text-[10px]">{configOpen ? "▲" : "▼"}</span>
            </button>

            {configOpen && (
              <div className="border-t border-white/10 px-3 pb-3 pt-2 space-y-2">
                {/* Profile selector */}
                <select
                  className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/10 text-xs text-white/80"
                  value={activeId || ""}
                  onChange={(e) => { setActiveId(e.target.value || null); didAutoConnect.current = false; }}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>

                <div className="flex gap-1.5">
                  {[["New", createProfile], ["Rename", renameProfile], ["Delete", deleteProfile]].map(([label, fn]) => (
                    <button
                      key={label as string}
                      className="px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/10 text-xs text-white/70 transition-colors"
                      onClick={fn as () => void}
                      disabled={label !== "New" && !activeProfile}
                    >
                      {label as string}
                    </button>
                  ))}
                </div>

                <div className="space-y-1.5 pt-1">
                  <label className="text-[11px] text-white/40">Command</label>
                  <input
                    className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/10 text-xs text-white/80 placeholder-white/20"
                    value={activeProfile?.command || ""}
                    onChange={(e) => updateProfile({ command: e.target.value })}
                    placeholder="e.g. node  or  C:\Program Files\nodejs\node.exe"
                  />

                  <label className="text-[11px] text-white/40">Args</label>
                  <input
                    className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/10 text-xs text-white/80 placeholder-white/20"
                    value={activeProfile?.args || ""}
                    onChange={(e) => updateProfile({ args: e.target.value })}
                    placeholder='server.js --config mcp-hub.config.json'
                  />

                  <label className="text-[11px] text-white/40">Working directory (optional)</label>
                  <input
                    className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/10 text-xs text-white/80 placeholder-white/20"
                    value={activeProfile?.cwd || ""}
                    onChange={(e) => updateProfile({ cwd: e.target.value })}
                    placeholder="C:\Users\you\project"
                  />

                  <label className="flex items-center gap-2 text-xs text-white/60 pt-0.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!activeProfile?.autoConnect}
                      onChange={(e) => updateProfile({ autoConnect: e.target.checked })}
                      className="accent-blue-500"
                    />
                    Auto-connect on startup & reconnect on drop
                  </label>

                  <div className="flex gap-2 pt-2">
                    <button
                      className="flex-1 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-semibold transition-colors"
                      onClick={handleConnect}
                      disabled={!activeProfile?.command || loading}
                    >
                      {loading ? "Connecting…" : "Connect"}
                    </button>
                    <button
                      className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 border border-white/10 text-xs text-white/70 disabled:opacity-40 transition-colors"
                      onClick={handleDisconnect}
                      disabled={loading || !connected}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Tools ── */}
          {tools.length > 0 && (
            <div className="border border-white/10 rounded-lg bg-white/5">
              {/* Search */}
              <div className="px-3 py-2 border-b border-white/10">
                <input
                  className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/10 text-xs text-white/80 placeholder-white/25"
                  placeholder={`Search ${tools.length} tools…`}
                  value={toolSearch}
                  onChange={(e) => setToolSearch(e.target.value)}
                />
              </div>

              {filteredTools.length === 0 ? (
                <div className="px-3 py-3 text-xs text-white/40">No tools match "{toolSearch}"</div>
              ) : (
                <div className="divide-y divide-white/5">
                  {[...groupedTools.entries()].map(([ns, groupTools]) => (
                    <div key={ns}>
                      {/* Group header */}
                      <button
                        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/5 transition-colors"
                        onClick={() => toggleGroup(ns)}
                      >
                        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">
                          {ns}
                          <span className="ml-1.5 font-normal text-white/30 normal-case tracking-normal">
                            ({groupTools.length})
                          </span>
                        </span>
                        <span className="text-white/20 text-[10px]">
                          {collapsedGroups.has(ns) ? "▶" : "▼"}
                        </span>
                      </button>

                      {/* Group tools */}
                      {!collapsedGroups.has(ns) && (
                        <div className="flex flex-wrap gap-1.5 px-3 pb-2.5 pt-1">
                          {groupTools.map((tool) => (
                            <ToolButton
                              key={tool.name}
                              tool={tool}
                              onClick={() => onInsertToComposer?.(`/tool ${tool.name} {}`)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Loading skeleton */}
          {toolsLoading && tools.length === 0 && (
            <div className="border border-white/10 rounded-lg bg-white/5 p-3">
              <div className="flex items-center gap-2 text-xs text-white/40">
                <span className="animate-spin inline-block w-3 h-3 border border-white/20 border-t-white/60 rounded-full" />
                Loading tools from server…
              </div>
            </div>
          )}

          {/* Not connected placeholder */}
          {!connected && !loading && tools.length === 0 && (
            <div className="border border-white/10 rounded-lg bg-white/5 p-3 text-xs text-white/35 text-center">
              Connect to an MCP server to load tools
            </div>
          )}

          {/* ── Recent tool log ── */}
          {toolLog.length > 0 && (
            <div className="border border-white/10 rounded-lg bg-white/5">
              <div className="px-3 py-2 text-[11px] font-semibold text-white/50 border-b border-white/8">
                Recent activity
              </div>
              <div className="divide-y divide-white/5 max-h-48 overflow-y-auto">
                {toolLog.map((x) => (
                  <div key={x.id} className="px-3 py-1.5">
                    <div className="text-xs text-white/70 truncate">{x.title}</div>
                    {x.detail && (
                      <div className="text-[11px] text-white/35 break-all mt-0.5 line-clamp-2">{x.detail}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}