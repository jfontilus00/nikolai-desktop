// ── Atelier NikolAi Desktop — STT Client (whisper.cpp server) ─────────────────
//
// The whisper.cpp server exposes ONE endpoint:
//   POST /inference   multipart/form-data
//   Fields:  file (audio blob), temperature, response_format
//   Returns: { "text": "transcribed text" }
//
// NOT /asr — that was a different (older) project.
// NOT /detect-language — not needed; whisper detects language automatically.
// NOT /docs — whisper-server has no API docs endpoint.
//
// Ping check: GET / returns 200 with an HTML form — use that to verify running.
//
// The audio blob from MediaRecorder is typically audio/webm (Chrome/Edge) or
// audio/ogg (Firefox). whisper-server accepts these directly if compiled with
// --convert, which we pass when starting via voice.rs. If Force WAV is enabled
// we convert to WAV first via the Web Audio API for best compatibility.

import type { VoiceSettings } from "./voiceSettings";

// ── WAV conversion ────────────────────────────────────────────────────────────
// Convert any audio blob → 16-bit 16kHz mono WAV.
// whisper-base.en works best with 16kHz mono.

async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuf = await blob.arrayBuffer();
  const ctx      = new OfflineAudioContext(1, 1, 16000);

  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuf);
  } catch {
    // If decode fails, send the raw blob and let whisper-server handle it
    return blob;
  }

  // Resample to 16kHz mono
  const length     = Math.ceil(audioBuffer.duration * 16000);
  const offlineCtx = new OfflineAudioContext(1, length, 16000);
  const src        = offlineCtx.createBufferSource();
  src.buffer       = audioBuffer;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered   = await offlineCtx.startRendering();

  // Encode as 16-bit PCM WAV
  const pcm        = rendered.getChannelData(0);
  const wavBuf     = new ArrayBuffer(44 + pcm.length * 2);
  const view       = new DataView(wavBuf);

  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4,  36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);   // PCM chunk size
  view.setUint16(20, 1, true);    // PCM format
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, 16000, true);// sample rate
  view.setUint32(28, 32000, true); // byte rate = 16000 * 1 * 2
  view.setUint16(32, 2, true);    // block align
  view.setUint16(34, 16, true);   // bits per sample
  writeStr(36, "data");
  view.setUint32(40, pcm.length * 2, true);

  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }

  return new Blob([wavBuf], { type: "audio/wav" });
}

// ── Core transcribe function ──────────────────────────────────────────────────

export async function sttTranscribe(
  blob: Blob,
  settings: VoiceSettings,
): Promise<string> {
  const base = (settings.sttBaseUrl || "http://127.0.0.1:9900").replace(/\/+$/, "");
  // Always use /inference — that is the ONLY valid endpoint on whisper-server
  const url  = `${base}/inference`;

  // Optionally convert to WAV for best compatibility
  let audioBlob = blob;
  if (settings.forceWav) {
    try { audioBlob = await blobToWav(blob); } catch { /* fall back to raw */ }
  }

  const ext      = audioBlob.type.includes("wav") ? "wav" : "webm";
  const filename = `audio.${ext}`;

  const form = new FormData();
  form.append("file",             new File([audioBlob], filename, { type: audioBlob.type }));
  form.append("temperature",      "0.0");
  form.append("temperature_inc",  "0.2");
  form.append("response_format",  "json");

  // Language: blank = auto-detect (recommended)
  const lang = (settings.sttLanguage || "").trim();
  if (lang) form.append("language", lang);

  const resp = await fetch(url, { method: "POST", body: form });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `STT failed (${resp.status}): ${body.slice(0, 200)}\n` +
      `Make sure whisper-server is running on port 9900. ` +
      `Check Voice panel → Start servers.`
    );
  }

  const data = await resp.json() as { text?: string; error?: string };

  if (data.error) throw new Error(`Whisper error: ${data.error}`);

  const text = (data.text || "").trim();
  if (!text) throw new Error("Whisper returned empty transcript. Try speaking louder or closer to mic.");

  // ── Silence token filter ──────────────────────────────────────────────────
  // Whisper outputs these special tokens when it hears only silence or noise.
  // They must NEVER be sent to the AI as chat messages — throw so the caller
  // shows "No speech detected" in the status bar instead.
  const silenceTokens = /^\[BLANK_AUDIO\]$|^\(silence\)$|^\[noise\]$|^\[Music\]$|^\[Applause\]$/i;
  if (silenceTokens.test(text)) {
    throw new Error("No speech detected — whisper heard only silence. Speak clearly after the ready tone.");
  }

  return text;
}

// ── Ping helper — checks if whisper-server is alive ──────────────────────────
// whisper-server responds with an HTML form at GET /
// Returns true if reachable, throws with message if not.

export async function sttPing(baseUrl: string): Promise<string> {
  const base = (baseUrl || "http://127.0.0.1:9900").replace(/\/+$/, "");
  // GET / returns the HTML upload form — confirms server is alive
  const resp = await fetch(`${base}/`, { method: "GET" });
  if (resp.ok) return `Whisper-server running ✓ (${resp.status} at ${base}/)`;
  throw new Error(`Server responded with ${resp.status} — may still be loading. Wait 10s and try again.`);
}