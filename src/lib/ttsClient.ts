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

// ── Audio state ───────────────────────────────────────────────────────────────

let currentAudio: HTMLAudioElement | null = null;
let currentBlobUrl: string | null = null;

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

// ── Main TTS function ─────────────────────────────────────────────────────────

export async function ttsSpeak(text: string, settings: VoiceSettings): Promise<void> {
  stopCurrentAudio();

  if (!text?.trim()) return;

  // ── Tauri path: call piper directly via Rust ──────────────────────────────
  // voice_tts_speak(text) → Vec<u8> (WAV bytes)
  // No HTTP server needed. Piper is called as a subprocess per request.
  if (isTauri && tauriInvoke) {
    const wavBytes = await tauriInvoke<number[]>("voice_tts_speak", { text: text.trim(), speed: Number(settings.ttsSpeed ?? 1.0) });
    const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
    const url  = URL.createObjectURL(blob);

    currentBlobUrl = url;
    const audio    = new Audio(url);
    currentAudio   = audio;

    return new Promise<void>((resolve, reject) => {
      audio.onended = () => {
        stopCurrentAudio();
        resolve();
      };
      audio.onerror = (e) => {
        stopCurrentAudio();
        reject(new Error(`Audio playback failed: ${JSON.stringify(e)}`));
      };
      audio.play().catch((e) => {
        stopCurrentAudio();
        reject(new Error(`Audio.play() failed: ${e?.message || String(e)}`));
      });
    });
  }

  // ── Browser/dev fallback: HTTP to port 9860 ───────────────────────────────
  // Only used in plain Vite dev mode (not inside the Tauri window).
  // Requires a piper HTTP wrapper running separately.
  const base = (settings.ttsBaseUrl || "http://127.0.0.1:9860").replace(/\/+$/, "");
  const path = settings.ttsPath || "/tts";

  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text:   text.trim(),
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
}

export function ttsStop(): void {
  stopCurrentAudio();
}

// ── Test helper ───────────────────────────────────────────────────────────────

export async function ttsTest(settings: VoiceSettings): Promise<void> {
  return ttsSpeak("Hello, I am NikolAi. Voice is working correctly.", settings);
}