import type { VoiceSettings } from "./voiceSettings";

function qs(params: Record<string, string>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v).length) u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

function parseSttResponse(raw: any): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  return raw.text || raw.transcription || raw.result?.text || raw.data?.text || "";
}

function normalizeLang(code: any): string {
  const s = String(code || "").trim();
  if (!s) return "";
  // take the first 2 letters if it looks like "en", "fr", "en-US", etc.
  const m = s.match(/[a-zA-Z]{2}/);
  return m ? m[0].toLowerCase() : "";
}

function parseDetectLanguage(raw: any): string {
  if (!raw) return "";
  if (typeof raw === "string") return normalizeLang(raw);

  // common shapes:
  // { language: "en" }
  // { lang: "en" }
  // { detected_language: "en" }
  // { result: { language: "en" } }
  // [{ language: "en", probability: 0.98 }, ...]
  const direct =
    raw.language ??
    raw.lang ??
    raw.detected_language ??
    raw.result?.language ??
    raw.result?.lang;

  if (direct) return normalizeLang(direct);

  if (Array.isArray(raw) && raw.length) {
    const first = raw[0];
    const v = first?.language ?? first?.lang;
    return normalizeLang(v);
  }

  return "";
}

function encodeWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;

  const interleaved = new Float32Array(numFrames * numChannels);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < numFrames; i++) interleaved[i * numChannels + ch] = data[i];
  }

  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = interleaved.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  let offset = 0;
  const writeString = (s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); };

  writeString("RIFF");
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, byteRate, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;
  writeString("data");
  view.setUint32(offset, dataSize, true); offset += 4;

  for (let i = 0; i < interleaved.length; i++) {
    let s = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

async function blobToWav(blob: Blob): Promise<Blob> {
  const ab = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const audio = await ctx.decodeAudioData(ab.slice(0));
  const wav = encodeWav(audio);
  try { await ctx.close(); } catch {}
  return new Blob([wav], { type: "audio/wav" });
}

async function postMultipart(url: string, blob: Blob, filename: string): Promise<Response> {
  async function postWithField(fieldName: string): Promise<Response> {
    const fd = new FormData();
    fd.append(fieldName, blob, filename);
    return await fetch(url, { method: "POST", body: fd });
  }

  // primary field name
  let r = await postWithField("audio_file");

  // fallback for other servers
  if (!r.ok && (r.status === 400 || r.status === 422)) {
    r = await postWithField("file");
  }

  return r;
}

async function detectLanguage(blob: Blob, filename: string, settings: VoiceSettings): Promise<string> {
  const base = settings.sttBaseUrl.replace(/\/+$/, "");
  const url = `${base}/detect-language`;

  const r = await postMultipart(url, blob, filename);

  if (!r.ok) {
    // detection failure should NOT block transcription
    return "";
  }

  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      const j = await r.json();
      return parseDetectLanguage(j);
    } catch {
      return "";
    }
  }

  // sometimes returns plain text
  const t = await r.text().catch(() => "");
  return normalizeLang(t);
}

export async function sttTranscribe(audio: Blob, settings: VoiceSettings): Promise<string> {
  const base = settings.sttBaseUrl.replace(/\/+$/, "");
  const path = settings.sttPath.startsWith("/") ? settings.sttPath : `/${settings.sttPath}`;

  let blob = audio;
  let filename = "audio.webm";

  if (settings.forceWav) {
    try {
      blob = await blobToWav(audio);
      filename = "audio.wav";
    } catch {}
  }

  // Language decision:
  // - if user typed a language => use it
  // - else if detectLanguageEnabled => call /detect-language, then use detected code
  // - else leave empty (server auto)
  let lang = String(settings.sttLanguage || "").trim();

  if (!lang && settings.detectLanguageEnabled) {
    try {
      lang = await detectLanguage(blob, filename, settings);
    } catch {
      // ignore
    }
  }

  const url = `${base}${path}${qs({ task: settings.sttTask || "transcribe", language: lang })}`;

  const r = await postMultipart(url, blob, filename);
  const ct = r.headers.get("content-type") || "";

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`STT failed (${r.status}): ${t.slice(0, 500)}`);
  }

  if (ct.includes("application/json")) {
    const j = await r.json();
    return String(parseSttResponse(j) || "").trim();
  }

  const t = await r.text();
  return String(t || "").trim();
}