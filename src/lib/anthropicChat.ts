export type AnthropicMsg = { role: "user" | "assistant"; content: string };

export async function anthropicChat(opts: {
  apiKey: string;
  model: string;
  system?: string;
  messages: AnthropicMsg[];
  signal?: AbortSignal;
}): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: opts.model,
      system: opts.system || "",
      max_tokens: 1024,
      messages: opts.messages
    }),
    signal: opts.signal
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic chat failed (${res.status}): ${txt || res.statusText}`);
  }

  const data: any = await res.json();
  const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.map((b) => (b?.type === "text" ? String(b.text || "") : "")).join("");
  return text.trim();
}