export type Role = "user" | "assistant" | "system";

export type Message = {
  id: string;
  role: Role;
  content: string;
  ts: number;
  // ── V3: image attachments ──────────────────────────────────────────────────
  // Base64-encoded image strings. Sent in the `images` field of Ollama messages.
  // Vision models (llava, bakllava, gemma3, moondream) read from here.
  images?: string[];
};

export type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  // ── V3: per-chat system prompt ─────────────────────────────────────────────
  // When set, injected as role:"system" at the top of every request.
  // Defaults to undefined (no system prompt = model default behaviour).
  systemPrompt?: string;
};

export type LayoutState = {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
};

// Backward-compatible: keep qwen_desktop so old saved settings still load.
export type ProviderKind = "ollama" | "openrouter" | "qwen" | "openai" | "anthropic" | "qwen_desktop";

export type ProviderConfig = {
  kind: ProviderKind;

  // Reused across all providers:
  // - Ollama: actual base URL
  // - OpenAI-compat: base URL of API endpoint (OpenRouter/Qwen/etc)
  // - Anthropic: ignored (we call official endpoint)
  ollamaBaseUrl: string;

  // Model name/id for whichever provider is active
  ollamaModel: string;

  // Planner used only for agentic+tools (Ollama-only)
  ollamaPlannerModel?: string;

  // Runtime-only (NOT persisted). Loaded from secure storage by profile id.
  apiKey?: string;
};