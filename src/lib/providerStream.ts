import type { Message, ProviderConfig } from "../types";
import { ollamaStreamChat } from "./ollamaStream";
import { openaiCompatStreamChat } from "./openaiCompatStream";
import { anthropicChat } from "./anthropicChat";

function chunkEmit(text: string, onToken: (t: string) => void) {
  const s = String(text || "");
  const size = 60;
  for (let i = 0; i < s.length; i += size) {
    onToken(s.slice(i, i + size));
  }
}

export async function streamChatWithProvider(opts: {
  provider: ProviderConfig;
  messages: Pick<Message, "role" | "content">[];
  signal: AbortSignal;
  onToken: (t: string) => void;
}): Promise<void> {
  const p: any = opts.provider;

  console.log("[ROUTER] sending to provider", {
    kind: p.kind,
    model: p.ollamaModel,
    endpoint: p.ollamaBaseUrl
  });

  if (!p.kind) {
    throw new Error("Provider kind is not set. Please configure your provider in Settings.");
  }

  if (p.kind === "ollama") {
    console.log("[PROVIDER] request start (Ollama)", {
      url: p.ollamaBaseUrl,
      model: p.ollamaModel
    });
    return await ollamaStreamChat({
      baseUrl: p.ollamaBaseUrl,
      model: p.ollamaModel,
      messages: opts.messages,
      signal: opts.signal,
      onToken: opts.onToken
    });
  }

  if (p.kind === "openrouter" || p.kind === "qwen" || p.kind === "openai") {
    const apiKey = String(p.apiKey || "").trim();
    if (!apiKey) throw new Error("API key is missing (Providers tab).");

    console.log("[PROVIDER] request start (OpenAI-compat)", {
      url: p.ollamaBaseUrl,
      model: p.ollamaModel
    });
    return await openaiCompatStreamChat({
      baseUrl: p.ollamaBaseUrl,
      apiKey,
      model: p.ollamaModel,
      messages: opts.messages as any,
      signal: opts.signal,
      onToken: opts.onToken
    });
  }

  if (p.kind === "anthropic") {
    const apiKey = String(p.apiKey || "").trim();
    if (!apiKey) throw new Error("Anthropic API key is missing (Providers tab).");

    console.log("[PROVIDER] request start (Anthropic)", {
      model: p.ollamaModel
    });

    const system = opts.messages
      .filter(m => m.role === "system")
      .map(m => String(m.content || ""))
      .join("\n\n");

    const msgs = opts.messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role as any, content: String(m.content || "") }));

    const out = await anthropicChat({
      apiKey,
      model: p.ollamaModel,
      system,
      messages: msgs as any,
      signal: opts.signal
    });

    chunkEmit(out, opts.onToken);
    return;
  }

  throw new Error(`Unknown provider kind: ${String(p.kind)}`);
}