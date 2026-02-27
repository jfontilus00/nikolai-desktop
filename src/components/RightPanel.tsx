import { useEffect, useMemo, useState } from "react";
import type { ProviderConfig, ProviderKind } from "../types";
import { uid } from "../lib/id";
import ToolsPanel from "./ToolsPanel";
import VoicePanel from "./VoicePanel";
import AboutPanel from "./AboutPanel";
import { fetchOllamaModels } from "../lib/ollamaModels";
import {
  loadProviderProfiles,
  saveProviderProfiles,
  loadActiveProviderProfileId,
  saveActiveProviderProfileId,
  type ProviderProfile,
} from "../lib/storage";
import { secretGet, secretSet, secretDelete } from "../lib/secrets";

type Props = {
  collapsed: boolean;
  provider: ProviderConfig;
  setProvider: (p: ProviderConfig) => void;
  onInsertToComposer?: (text: string) => void;
};

function kindLabel(kind: ProviderKind) {
  switch (kind) {
    case "openrouter":
      return "OpenRouter (OpenAI-compatible)";
    case "qwen":
      return "Qwen (OpenAI-compatible)";
    case "openai":
      return "OpenAI-compatible (generic)";
    case "anthropic":
      return "Anthropic (direct)";
    case "qwen_desktop":
      return "Qwen Desktop (compat)";
    default:
      return "Ollama (local / LAN)";
  }
}

function isOllamaKind(kind: ProviderKind) {
  return (kind || "ollama") === "ollama";
}

function normalizeKind(kind: ProviderKind): ProviderKind {
  // migrate old value
  if (kind === "qwen_desktop") return "qwen";
  return kind;
}

function stripApiKey(p: ProviderConfig): ProviderConfig {
  const anyP: any = p || {};
  const { apiKey: _drop, ...rest } = anyP;
  return rest as ProviderConfig;
}

export default function RightPanel({
  collapsed,
  provider,
  setProvider,
  onInsertToComposer,
}: Props) {
  const [tab, setTab] = useState<"providers" | "tools" | "voice" | "about">(
    "providers"
  );

  // --- Profiles ---
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() =>
    loadProviderProfiles()
  );
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() =>
    loadActiveProviderProfileId()
  );

  // --- API key (secure) ---
  const [apiKeyDraft, setApiKeyDraft] = useState<string>("");
  const [apiKeyStatus, setApiKeyStatus] = useState<string | null>(null);

  // --- Ollama models dropdown ---
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const kind = normalizeKind((provider?.kind || "ollama") as ProviderKind);
  const baseUrl = provider?.ollamaBaseUrl || "";
  const chatModel = provider?.ollamaModel || "";
  const plannerModel = provider?.ollamaPlannerModel || chatModel;

  const secretKeyForProfile = (profileId: string) =>
    `provider_api_key:${profileId}`;

  // Ensure there is at least 1 profile
  useEffect(() => {
    if (profiles.length > 0 && activeProfileId) return;

    const now = Date.now();
    const p: ProviderProfile = {
      id: uid("prov"),
      name: "Default",
      createdAt: now,
      updatedAt: now,
      provider: stripApiKey(provider),
    };

    const next = [p, ...profiles];
    setProfiles(next);
    saveProviderProfiles(next);

    setActiveProfileId(p.id);
    saveActiveProviderProfileId(p.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep active profile id saved
  useEffect(() => {
    saveActiveProviderProfileId(activeProfileId || null);
  }, [activeProfileId]);

  // Sync provider -> active profile (so edits are saved to the selected profile)
  useEffect(() => {
    if (!activeProfileId) return;
    const next = profiles.map((p) =>
      p.id === activeProfileId
        ? { ...p, provider: stripApiKey(provider), updatedAt: Date.now() }
        : p
    );
    setProfiles(next);
    saveProviderProfiles(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeProfileId,
    provider.kind,
    provider.ollamaBaseUrl,
    provider.ollamaModel,
    provider.ollamaPlannerModel,
  ]);

  // Load api key from secure storage when profile/kind changes
  useEffect(() => {
    const run = async () => {
      setApiKeyStatus(null);

      if (!activeProfileId) return;
      if (isOllamaKind(kind)) {
        setApiKeyDraft("");
        return;
      }

      const key = secretKeyForProfile(activeProfileId);
      const v = await secretGet(key);
      setApiKeyDraft(v || "");

      // Attach runtime apiKey to provider state so chat works (storage.ts will not persist apiKey)
      if (v && v.length) {
        setProvider({ ...(provider as any), apiKey: v } as any);
      } else {
        setProvider({ ...(provider as any), apiKey: "" } as any);
      }
    };

    run().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileId, kind]);

  const refreshModels = async () => {
    if (!isOllamaKind(kind)) {
      setModels([]);
      setModelsError(null);
      return;
    }

    setModelsLoading(true);
    setModelsError(null);
    try {
      const list = await fetchOllamaModels(baseUrl);
      setModels(list);
      if (list.length === 0) setModelsError("No models returned by /api/tags");
    } catch (e: any) {
      setModels([]);
      setModelsError(e?.message || String(e));
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "providers" && isOllamaKind(kind) && baseUrl.trim()) {
      refreshModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, kind, baseUrl]);

  const modelOptions = useMemo(() => models, [models]);

  const applyProfile = async (id: string) => {
    setActiveProfileId(id);

    const prof = profiles.find((p) => p.id === id);
    if (!prof) return;

    setProvider(stripApiKey(prof.provider));

    const k = normalizeKind((prof.provider.kind || "ollama") as ProviderKind);
    if (k !== "ollama") {
      const sec = await secretGet(secretKeyForProfile(id));
      setApiKeyDraft(sec || "");
      setProvider({ ...(prof.provider as any), apiKey: sec || "" } as any);
    } else {
      setApiKeyDraft("");
    }
  };

  const createProfile = () => {
    const name = prompt("Profile name", "New profile");
    if (!name || !name.trim()) return;

    const now = Date.now();
    const p: ProviderProfile = {
      id: uid("prov"),
      name: name.trim(),
      createdAt: now,
      updatedAt: now,
      provider: stripApiKey(provider),
    };

    const next = [p, ...profiles];
    setProfiles(next);
    saveProviderProfiles(next);

    setActiveProfileId(p.id);
    saveActiveProviderProfileId(p.id);
  };

  const renameProfile = () => {
    if (!activeProfileId) return;
    const prof = profiles.find((p) => p.id === activeProfileId);
    if (!prof) return;

    const name = prompt("Rename profile", prof.name);
    if (!name || !name.trim()) return;

    const next = profiles.map((p) =>
      p.id === activeProfileId
        ? { ...p, name: name.trim(), updatedAt: Date.now() }
        : p
    );
    setProfiles(next);
    saveProviderProfiles(next);
  };

  const deleteProfile = async () => {
    if (!activeProfileId) return;

    const prof = profiles.find((p) => p.id === activeProfileId);
    const label = prof ? prof.name : activeProfileId;
    if (!confirm(`Delete profile "${label}"?`)) return;

    await secretDelete(secretKeyForProfile(activeProfileId));

    const next = profiles.filter((p) => p.id !== activeProfileId);
    setProfiles(next);
    saveProviderProfiles(next);

    const nextActive = next[0]?.id ?? null;
    setActiveProfileId(nextActive);
    saveActiveProviderProfileId(nextActive);

    if (nextActive) {
      await applyProfile(nextActive);
    }
  };

  const saveApiKey = async () => {
    if (!activeProfileId) return;
    if (isOllamaKind(kind)) return;

    const v = String(apiKeyDraft || "").trim();
    const key = secretKeyForProfile(activeProfileId);

    try {
      await secretSet(key, v);
      setApiKeyStatus("Saved to secure store.");
      setProvider({ ...(provider as any), apiKey: v } as any);
    } catch (e: any) {
      setApiKeyStatus(e?.message || "Failed to save key.");
    }
  };

  const clearApiKey = async () => {
    if (!activeProfileId) return;
    const key = secretKeyForProfile(activeProfileId);
    await secretDelete(key);
    setApiKeyDraft("");
    setApiKeyStatus("Key cleared.");
    setProvider({ ...(provider as any), apiKey: "" } as any);
  };

  if (collapsed) return <div className="h-full w-full" />;

  return (
    <div className="h-full flex flex-col border-l border-white/10">
      <div className="h-12 flex items-center gap-2 px-3 border-b border-white/10">
        <button
          className={`px-3 py-1 rounded ${
            tab === "providers" ? "bg-white/10" : "bg-transparent"
          } hover:bg-white/10`}
          onClick={() => setTab("providers")}
        >
          Providers
        </button>

        <button
          className={`px-3 py-1 rounded ${
            tab === "tools" ? "bg-white/10" : "bg-transparent"
          } hover:bg-white/10`}
          onClick={() => setTab("tools")}
        >
          Tools
        </button>

        <button
          className={`px-3 py-1 rounded ${
            tab === "voice" ? "bg-white/10" : "bg-transparent"
          } hover:bg-white/10`}
          onClick={() => setTab("voice")}
        >
          Voice
        </button>

        <button
          className={`px-3 py-1 rounded ${
            tab === "about" ? "bg-white/10" : "bg-transparent"
          } hover:bg-white/10`}
          onClick={() => setTab("about")}
        >
          About
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {tab === "providers" && (
          <div className="space-y-3">
            <div className="text-xs font-semibold opacity-80">
              Provider Profiles
            </div>

            <div className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-3">
              <label className="block text-xs opacity-70">Active profile</label>

              <select
                className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                value={activeProfileId || ""}
                onChange={(e) => applyProfile(e.target.value)}
              >
                {profiles.length === 0 ? (
                  <option value="">(no profiles)</option>
                ) : null}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <div className="flex gap-2">
                <button
                  className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
                  onClick={createProfile}
                >
                  New
                </button>
                <button
                  className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
                  onClick={renameProfile}
                  disabled={!activeProfileId}
                >
                  Rename
                </button>
                <button
                  className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
                  onClick={deleteProfile}
                  disabled={!activeProfileId}
                >
                  Delete
                </button>
              </div>
            </div>

            <div className="text-xs font-semibold opacity-80">Active Provider</div>

            <div className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-3">
              <div className="text-xs opacity-70">{kindLabel(kind)}</div>

              <label className="block text-xs opacity-70">Provider kind</label>
              <select
                className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                value={kind}
                onChange={(e) => {
                  const nextKind = normalizeKind(e.target.value as ProviderKind);
                  setProvider({ ...(provider as any), kind: nextKind } as any);

                  if (nextKind === "ollama") {
                    setApiKeyDraft("");
                    setApiKeyStatus(null);
                  }
                }}
              >
                <option value="ollama">Ollama (local / LAN)</option>
                <option value="openrouter">OpenRouter (OpenAI-compatible)</option>
                <option value="qwen">Qwen (OpenAI-compatible)</option>
                <option value="openai">OpenAI-compatible (generic)</option>
                <option value="anthropic">Anthropic (direct)</option>
              </select>

              {kind !== "anthropic" ? (
                <>
                  <label className="block text-xs opacity-70">Base URL</label>
                  <input
                    className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                    value={baseUrl}
                    onChange={(e) =>
                      setProvider({
                        ...(provider as any),
                        ollamaBaseUrl: e.target.value,
                      } as any)
                    }
                    placeholder={
                      kind === "ollama"
                        ? "http://127.0.0.1:11434"
                        : "https://openrouter.ai/api/v1"
                    }
                  />
                  {kind === "openrouter" ? (
                    <div className="text-[11px] opacity-60">
                      OpenRouter base URL typically ends with{" "}
                      <span className="font-mono">/api/v1</span>.
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="text-[11px] opacity-60">
                  Anthropic doesn’t need a base URL here (we call the official
                  endpoint).
                </div>
              )}

              {kind !== "ollama" ? (
                <>
                  <label className="block text-xs opacity-70">
                    API key (secure)
                  </label>
                  <input
                    type="password"
                    className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    placeholder="stored in OS keychain"
                  />
                  <div className="flex gap-2">
                    <button
                      className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-sm font-semibold disabled:opacity-50"
                      onClick={saveApiKey}
                      disabled={!activeProfileId}
                    >
                      Save key
                    </button>
                    <button
                      className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm disabled:opacity-50"
                      onClick={clearApiKey}
                      disabled={!activeProfileId}
                    >
                      Clear key
                    </button>
                  </div>
                  {apiKeyStatus ? (
                    <div className="text-xs text-amber-300">{apiKeyStatus}</div>
                  ) : null}
                </>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                <label className="block text-xs opacity-70">
                  Chat model (answers)
                </label>
                {kind === "ollama" ? (
                  <button
                    className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/10 disabled:opacity-50"
                    onClick={refreshModels}
                    disabled={modelsLoading || !baseUrl.trim()}
                  >
                    {modelsLoading ? "Loading…" : "Refresh models"}
                  </button>
                ) : null}
              </div>

              {kind === "ollama" ? (
                <>
                  <select
                    className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                    value={chatModel}
                    onChange={(e) =>
                      setProvider({
                        ...(provider as any),
                        ollamaModel: e.target.value,
                      } as any)
                    }
                  >
                    {modelOptions.length === 0 ? (
                      <option value={chatModel || ""}>
                        {chatModel ? chatModel : "No models loaded"}
                      </option>
                    ) : (
                      modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    )}
                  </select>

                  <div className="text-[11px] opacity-60">
                    Tip: You can type a model manually if it isn't listed.
                  </div>
                  <input
                    className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                    value={chatModel}
                    onChange={(e) =>
                      setProvider({
                        ...(provider as any),
                        ollamaModel: e.target.value,
                      } as any)
                    }
                    placeholder="e.g. qwen2.5:7b-instruct-q4_K_M"
                  />
                </>
              ) : (
                <>
                  <input
                    className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                    value={chatModel}
                    onChange={(e) =>
                      setProvider({
                        ...(provider as any),
                        ollamaModel: e.target.value,
                      } as any)
                    }
                    placeholder={
                      kind === "anthropic"
                        ? "e.g. claude-3-5-sonnet-latest"
                        : "e.g. openai/gpt-4o-mini"
                    }
                  />
                  <div className="text-[11px] opacity-60">
                    For API providers, model names come from the provider you
                    selected.
                  </div>
                </>
              )}

              {kind === "ollama" ? (
                <div className="border-t border-white/10 pt-3 space-y-2">
                  <div className="text-xs font-semibold opacity-80">
                    Planner model (agentic tools)
                  </div>
                  <div className="text-xs opacity-70">
                    Used only for tool planning. Final answers still use Chat
                    model.
                  </div>

                  <select
                    className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                    value={plannerModel}
                    onChange={(e) =>
                      setProvider({
                        ...(provider as any),
                        ollamaPlannerModel: e.target.value,
                      } as any)
                    }
                  >
                    {modelOptions.length === 0 ? (
                      <option value={plannerModel || ""}>
                        {plannerModel ? plannerModel : "No models loaded"}
                      </option>
                    ) : (
                      modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    )}
                  </select>

                  <input
                    className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                    value={plannerModel}
                    onChange={(e) =>
                      setProvider({
                        ...(provider as any),
                        ollamaPlannerModel: e.target.value,
                      } as any)
                    }
                    placeholder="e.g. nvidia-orchestrator:8b-q4_K_M"
                  />
                </div>
              ) : (
                <div className="text-xs opacity-60 border-t border-white/10 pt-3">
                  Tools + agentic planning remain{" "}
                  <span className="font-semibold">Ollama-only</span> for safety.
                </div>
              )}

              {modelsError ? (
                <div className="text-xs text-amber-300">{modelsError}</div>
              ) : null}
            </div>
          </div>
        )}

        {tab === "tools" && <ToolsPanel onInsertToComposer={onInsertToComposer} />}

        {tab === "voice" && (
          <VoicePanel onInsertToComposer={onInsertToComposer} />
        )}

        {tab === "about" && <AboutPanel />}
      </div>
    </div>
  );
}
