// ── Atelier NikolAi Desktop — TTS Client ─────────────────────────────────────
//
// Piper has NO HTTP server mode. In the Tauri app we call piper directly
// via the voice_tts_speak Rust command which returns WAV bytes.
//
// In browser/dev mode (Vite without Tauri) we fall back to HTTP on port 9860
// so you can still test with a local piper HTTP wrapper if you have one.
//
// The VoicePanel no longer needs to "start piper as a server" — piper
// is called per-request by Rust. Only whisper-server needs to be started.

import type { VoiceSettings } from "./voiceSettings";

// ── Tauri guard ───────────────────────────────────────────────────────────────

const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI__;
let tauriInvoke: typeof import("@tauri-apps/api/tauri").invoke | null = null;
if (isTauri) {
  import("@tauri-apps/api/tauri").then((m) => { tauriInvoke = m.invoke; }).catch(() => {});
}

// ── Markdown Stripping for TTS ────────────────────────────────────────────────
// Removes markdown syntax from text before sending to speech engine.
// Prevents TTS from reading "**bold**" as "star star bold star star".

export function stripMarkdownForTTS(text: string): string {
  return text
    // Remove fenced code blocks entirely — never speak code
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")

    // Remove inline code — keep the text inside
    .replace(/`([^`]*)`/g, "$1")

    // Markdown links → keep display text only
    // [link text](https://...) → "link text"
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

    // Remove bare URLs
    .replace(/https?:\/\/\S+/g, "")
    .replace(/www\.\S+/g, "")

    // Remove HTML tags and entities
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/&#\d+;/g, " ")

    // Headers
    .replace(/^#{1,6}\s+/gm, "")

    // Bold + italic (order matters: *** before ** before *)
    .replace(/\*{3}([^*]+)\*{3}/g, "$1")
    .replace(/\*{2}([^*]+)\*{2}/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_{3}([^_]+)_{3}/g, "$1")
    .replace(/_{2}([^_]+)_{2}/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")

    // Strikethrough
    .replace(/~~([^~]+)~~/g, "$1")

    // Blockquotes
    .replace(/^>\s*/gm, "")

    // Horizontal rules
    .replace(/^(-{3,}|_{3,}|\*{3,})\s*$/gm, "")

    // Bullet lists
    .replace(/^[\s]*[-*+]\s+/gm, "")

    // Numbered lists
    .replace(/^\s*\d+\.\s+/gm, "")

    // Table formatting
    .replace(/\|/g, " ")
    .replace(/^[\s|:-]+$/gm, "")

    // Ellipsis → short pause (space, not comma — avoids odd rhythm)
    .replace(/\.{3,}/g, " ")
    .replace(/…/g, " ")

    // Emoji — remove all emoji (ES2018+ Unicode property escape)
    .replace(/\p{Extended_Pictographic}/gu, "")

    // Replace file path separators with space (keep existing behaviour)
    .replace(/\//g, " ")

    // Remove remaining stray markdown symbols
    .replace(/[#*_~`\\^]/g, "")

    // Collapse whitespace
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")

    .trim();
}

// ── Audio state ───────────────────────────────────────────────────────────────

let currentAudio: HTMLAudioElement | null = null;
let currentBlobUrl: string | null = null;

let isSpeaking = false;

// Shared AudioContext — created once, reused across all TTS calls
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)({ sampleRate: PIPER_SAMPLE_RATE });
    console.log("[TTS:ctx] AudioContext created");
  }
  if (sharedAudioContext.state === "suspended") {
    sharedAudioContext.resume().catch(() => {});
  }
  return sharedAudioContext;
}

export function isTtsSpeaking(): boolean {
  return isSpeaking;
}

function stopCurrentAudio() {
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.src = ""; } catch {}
    currentAudio = null;
  }
  if (currentBlobUrl) {
    try { URL.revokeObjectURL(currentBlobUrl); } catch {}
    currentBlobUrl = null;
  }
}

export function stopTTS(): void {
  ttsQueue.length = 0;
  stopCurrentAudio();
  isProcessingQueue = false;
  // Also close any active streaming AudioContext
  // by emitting a cancel signal (streaming path checks this)
  isSpeaking = false;
  console.log("[TTS] interrupted by user speech");
}

// ── Main TTS function ─────────────────────────────────────────────────────────

export async function ttsSpeak(text: string, settings: VoiceSettings): Promise<void> {
  console.log("[TTS:1] ttsSpeak called, isSpeaking=", isSpeaking, "text=", text.slice(0,60));

  if (isSpeaking) {
    console.log("[TTS] interrupt previous speech");
    stopCurrentAudio();
  }

  stopCurrentAudio();
  console.log("[TTS:2] stopCurrentAudio done");

  if (!text?.trim()) {
    console.log("[TTS] empty text, skipping");
    return;
  }

  // ── Strip markdown syntax before speech ───────────────────────────────────
  // Prevents TTS from reading markdown characters literally.
  const cleanText = stripMarkdownForTTS(text.trim());
  console.log("[TTS:4] cleanText=", cleanText.slice(0,60));

  if (!cleanText) {
    console.log("[TTS] cleaned text empty");
    return;
  }

  isSpeaking = true;
  console.log("[TTS:3] isSpeaking set true");

  console.log("[TTS] cleaned text:", cleanText.slice(0, 120));

  try {
    // ── Tauri path: call piper directly via Rust ──────────────────────────────
    // voice_tts_speak(text) → Vec<u8> (WAV bytes)
    // No HTTP server needed. Piper is called as a subprocess per request.
    if (isTauri && tauriInvoke) {
      // Try streaming path first — plays first audio ~200ms after call
      try {
        console.log("[TTS] attempting streaming playback");
        await ttsStreamSpeak(cleanText, settings);
        console.log("[TTS] streaming playback succeeded");
        return;
      } catch (streamErr) {
        console.warn("[TTS] streaming failed, falling back to buffer mode:", streamErr);
      }

      console.log("[TTS:5] calling tauri voice_tts_speak");
      const wavBytes = await tauriInvoke<number[]>("voice_tts_speak", { text: cleanText, speed: Number(settings.ttsSpeed ?? 1.0) });
      console.log("[TTS:6] wav bytes=", wavBytes?.length);
      const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });

      // Try AudioContext first (more reliable in Tauri WebView for WAV)
      try {
        console.log("[TTS] attempting AudioContext playback");
        await ttsPlayRaw(wavBytes);
        console.log("[TTS] AudioContext playback succeeded");
        return;
      } catch (ctxErr) {
        console.warn("[TTS] AudioContext failed, falling back to HTML Audio:", ctxErr);
      }

      // HTML Audio fallback
      const url = URL.createObjectURL(blob);
      currentBlobUrl = url;
      const audio = new Audio(url);
      currentAudio = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => { stopCurrentAudio(); resolve(); };
        audio.onerror = (e) => {
          const mediaErr = ((e as Event).target as HTMLAudioElement)?.error;
          console.error("[TTS:ERR] MediaError code=", mediaErr?.code, "message=", mediaErr?.message);
          console.error("[TTS:ERR] code meanings: 1=aborted 2=network 3=decode_failed 4=format_unsupported");
          stopCurrentAudio();
          reject(new Error(`Audio playback failed: code=${mediaErr?.code}`));
        };
        audio.play().catch(reject);
      });

      return;
    }

    // ── Browser/dev fallback: HTTP to port 9860 ───────────────────────────────
    console.log("[TTS:11] using SpeechSynthesis fallback");
    // Only used in plain Vite dev mode (not inside the Tauri window).
    // Requires a piper HTTP wrapper running separately.
    const base = (settings.ttsBaseUrl || "http://127.0.0.1:9860").replace(/\/+$/, "");
    const path = settings.ttsPath || "/tts";

    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text:   cleanText,
        speed:  Number(settings.ttsSpeed ?? 1.0),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `TTS HTTP request failed (${response.status}): ${body.slice(0, 200)}\n` +
        `Note: In Tauri builds, TTS uses the voice_tts_speak command instead of HTTP. ` +
        `This HTTP fallback only works in plain browser dev mode.`
      );
    }

    const audioBlob   = await response.blob();
    const url         = URL.createObjectURL(audioBlob);
    currentBlobUrl    = url;
    const audio       = new Audio(url);
    currentAudio      = audio;

    return new Promise<void>((resolve, reject) => {
      audio.onended = () => { stopCurrentAudio(); resolve(); };
      audio.onerror = (e) => { stopCurrentAudio(); reject(new Error(`Playback error: ${String(e)}`)); };
      audio.play().catch((e) => { stopCurrentAudio(); reject(new Error(e?.message || String(e))); });
    });
  } finally {
    isSpeaking = false;
    console.log("[TTS] isSpeaking released");
  }
}

export function ttsStop(): void {
  stopCurrentAudio();
}

export async function ttsPlayRaw(wavBytes: number[]): Promise<void> {
  const arrayBuffer = new Uint8Array(wavBytes).buffer;
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

  return new Promise<void>((resolve, reject) => {
    audioCtx.decodeAudioData(
      arrayBuffer,
      (buffer) => {
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.onended = () => {
          audioCtx.close();
          resolve();
        };
        source.start(0);
        console.log("[TTS:AudioCtx] playback started via AudioContext");
      },
      (err) => {
        console.error("[TTS:AudioCtx] decodeAudioData failed:", err);
        audioCtx.close();
        reject(err);
      }
    );
  });
}

const ttsQueue: string[] = [];
let isProcessingQueue = false;

// ── Streaming TTS via Tauri events ────────────────────────────────────────────
// Uses voice_tts_speak_stream command which emits raw PCM chunks as Piper generates.
// Plays each chunk gaplessly via AudioContext — first sound ~200ms after call.

// Piper lessac-medium outputs 22050Hz mono 16-bit signed PCM.
// IMPORTANT: verify this matches your model's sample_rate in the .onnx.json file.
const PIPER_SAMPLE_RATE = 22050;

export async function ttsStreamSpeak(
  text: string,
  settings: VoiceSettings
): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  const { invoke } = await import("@tauri-apps/api/tauri");

  const audioCtx = getAudioContext();

  let nextPlayTime = audioCtx.currentTime;
  let chunkCount = 0;

  return new Promise<void>((resolve, reject) => {
    // Store unlisten functions so we can always clean up
    // regardless of how the Promise ends
    let unlistenChunkFn: (() => void) | null = null;
    let unlistenDoneFn: (() => void) | null = null;
    let unlistenErrorFn: (() => void) | null = null;

    // Cleanup helper — always removes all 3 listeners
    function cleanupListeners() {
      unlistenChunkFn?.();
      unlistenDoneFn?.();
      unlistenErrorFn?.();
      unlistenChunkFn = null;
      unlistenDoneFn = null;
      unlistenErrorFn = null;
    }

    // Set up listeners and store their unlisten functions
    listen<string>("tts-chunk", (event) => {
      try {
        // base64 → raw PCM bytes
        const binary = atob(event.payload);
        const pcmBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          pcmBytes[i] = binary.charCodeAt(i);
        }

        // 16-bit signed little-endian PCM → Float32
        const samples = Math.floor(pcmBytes.length / 2);
        if (samples === 0) return;

        const float32 = new Float32Array(samples);
        const view = new DataView(pcmBytes.buffer);
        for (let i = 0; i < samples; i++) {
          float32[i] = view.getInt16(i * 2, true) / 32768.0;
        }

        // Schedule gaplessly after previous chunk
        const buffer = audioCtx.createBuffer(1, samples, PIPER_SAMPLE_RATE);
        buffer.copyToChannel(float32, 0);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);

        const startTime = Math.max(nextPlayTime, audioCtx.currentTime + 0.01);
        source.start(startTime);
        nextPlayTime = startTime + buffer.duration;
        chunkCount++;

        console.log(`[TTS:stream] chunk ${chunkCount}, ${samples} samples, starts at ${startTime.toFixed(3)}s`);
      } catch (e) {
        console.warn("[TTS:stream] chunk decode error:", e);
      }
    }).then((fn) => { unlistenChunkFn = fn; });

    listen("tts-done", async () => {
      cleanupListeners();  // ← remove all 3 listeners first

      // Wait for last scheduled chunk to finish playing
      const remaining = nextPlayTime - audioCtx.currentTime;
      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, remaining * 1000 + 150));
      }

      console.log(`[TTS:stream] complete — ${chunkCount} chunks`);
      resolve();
    }).then((fn) => { unlistenDoneFn = fn; });

    listen<string>("tts-error", async (event) => {
      cleanupListeners();  // ← remove all 3 listeners first
      reject(new Error(`TTS stream error: ${event.payload}`));
    }).then((fn) => { unlistenErrorFn = fn; });

    // Kick off synthesis — Rust will emit tts-chunk events as it reads Piper stdout
    invoke("voice_tts_speak_stream", {
      text,
      speed: settings.ttsSpeed ?? 1.0,
    }).catch((err) => {
      cleanupListeners();  // ← also cleanup if invoke itself fails
      reject(err);
    });
  });
}

export async function ttsSpeakQueued(text: string, settings: VoiceSettings): Promise<void> {
  // Cap queue at 8 — drop oldest stale items if backlog builds up
  if (ttsQueue.length >= 8) {
    const dropped = ttsQueue.splice(0, ttsQueue.length - 7);
    console.warn(`[TTS:queue] overflow — dropped ${dropped.length} stale items`);
  }

  ttsQueue.push(text);

  if (isProcessingQueue) return;

  isProcessingQueue = true;

  while (ttsQueue.length > 0) {
    const next = ttsQueue.shift()!;
    try {
      await ttsSpeak(next, settings);
    } catch (e) {
      console.warn("[TTS queue error]", e);
    }
  }

  isProcessingQueue = false;
}

// ── Test helper ───────────────────────────────────────────────────────────────

export async function ttsTest(settings: VoiceSettings): Promise<void> {
  return ttsSpeak("Hello, I am NikolAi. Voice is working correctly.", settings);
}

/**
 * Pre-warms Piper by synthesising a near-silent phrase at app startup.
 * Forces the voice model to load into memory so the first real TTS call
 * responds in ~300ms instead of ~2000ms.
 *
 * Uses "." as the warmup text — Piper produces near-zero audio output
 * for a single period, so the user hears nothing.
 */
export async function ttsPrimeVoice(): Promise<void> {
  try {
    const isTauri = typeof window !== "undefined" && "__TAURI__" in window;
    if (!isTauri) return;

    const { invoke } = await import("@tauri-apps/api/tauri");

    console.log("[TTS:warmup] pre-warming Piper...");

    await invoke("voice_tts_speak", {
      text: ".",          // ← single period: forces model load, no audible output
      speed: 1.0,
    });

    console.log("[TTS:warmup] ready — first response will be fast");
  } catch (e) {
    // Non-fatal — warmup fail just means first call is slower
    console.log("[TTS:warmup] skipped:", e);
  }
}
