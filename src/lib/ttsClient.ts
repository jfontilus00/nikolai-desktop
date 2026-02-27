import type { VoiceSettings } from "./voiceSettings";

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

// resolves when the current audio ends (or is stopped)
let currentDone: (() => void) | null = null;

export function ttsStop() {
  try {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    }
  } catch {}

  try {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  } catch {}

  try {
    currentDone?.();
  } catch {}

  currentAudio = null;
  currentUrl = null;
  currentDone = null;
}

export async function ttsSpeak(text: string, settings: VoiceSettings): Promise<void> {
  const s = String(text || "").trim();
  if (!s) return;

  // stop any previous playback
  ttsStop();

  const base = settings.ttsBaseUrl.replace(/\/+$/, "");
  const path = settings.ttsPath.startsWith("/") ? settings.ttsPath : `/${settings.ttsPath}`;
  const url = `${base}${path}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: s, speed: settings.ttsSpeed || 1.0 }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`TTS failed (${r.status}): ${t.slice(0, 500)}`);
  }

  const ct = r.headers.get("content-type") || "audio/wav";
  const buf = await r.arrayBuffer();
  const blob = new Blob([buf], { type: ct.includes("audio/") ? ct : "audio/wav" });

  currentUrl = URL.createObjectURL(blob);
  currentAudio = new Audio(currentUrl);

  // Promise that resolves when playback is finished
  const done = new Promise<void>((resolve) => {
    currentDone = resolve;

    if (!currentAudio) return resolve();

    currentAudio.onended = () => {
      try {
        if (currentUrl) URL.revokeObjectURL(currentUrl);
      } catch {}
      currentAudio = null;
      currentUrl = null;
      currentDone = null;
      resolve();
    };

    currentAudio.onerror = () => {
      try {
        if (currentUrl) URL.revokeObjectURL(currentUrl);
      } catch {}
      currentAudio = null;
      currentUrl = null;
      currentDone = null;
      resolve();
    };
  });

  // Start playback
  await currentAudio.play();

  // Wait until it ends
  await done;
}
