export type OpenAICompatMsg = { role: "system" | "user" | "assistant"; content: string };

function normalizeBase(baseUrl: string) {
  const b = (baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/v1$/i.test(b)) return b;
  if (/\/api\/v1$/i.test(b)) return b;
  return b + "/v1";
}

function endpoint(baseUrl: string) {
  const b = normalizeBase(baseUrl);
  return b.replace(/\/+$/, "") + "/chat/completions";
}

export async function openaiCompatChat(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAICompatMsg[];
  signal?: AbortSignal;
}): Promise<string> {
  const url = endpoint(opts.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.apiKey}`
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: false,
      temperature: 0.2
    }),
    signal: opts.signal
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI-compat chat failed (${res.status}): ${txt || res.statusText}`);
  }

  const data: any = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}