import type { OpenAICompatMsg } from "./openaiCompatChat";

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

export async function openaiCompatStreamChat(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAICompatMsg[];
  signal: AbortSignal;
  onToken: (t: string) => void;
}): Promise<void> {
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
      stream: true,
      temperature: 0.2
    }),
    signal: opts.signal
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI-compat stream failed (${res.status}): ${txt || res.statusText}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);

        if (!line) continue;
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;

        let obj: any;
        try { obj = JSON.parse(payload); } catch { continue; }

        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length) {
          opts.onToken(delta);
        }
      }
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    throw e;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}