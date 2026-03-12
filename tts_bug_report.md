# TTS Bug Report

## 1) stopCurrentAudio() body
File: `src/lib/ttsClient.ts`
```ts
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
```

## 2) Recursive sentence calls and stopCurrentAudio()
In the current `src/lib/ttsClient.ts`, there is no sentence-splitting or recursive call inside `ttsSpeak()`. The function begins by calling `stopCurrentAudio()` on every invocation:
```ts
export async function ttsSpeak(text: string, settings: VoiceSettings): Promise<void> {
  console.log("[TTS] speak request:", text.slice(0, 120));
  stopCurrentAudio();
  ...
}
```
So any call to `ttsSpeak()` will first stop any currently playing audio.

## 3) maybeAutoSpeakLastAssistant triggers
`maybeAutoSpeakLastAssistant` is a regular function; it is not in a `useEffect` or a polling interval. It is invoked from code paths (not shown in the requested snippet range) when a message finishes streaming or after certain actions. The function itself is here:
File: `src/App.tsx:479`
```ts
async function maybeAutoSpeakLastAssistant(chatId?: string) {
  try {
    const vs = loadVoiceSettings();
    if (!vs.autoSpeak) return;
    const all = loadChats();
    const id = chatId || loadActiveChatId();
    const thread = all.find((c) => c.id === id) || all[0];
    const msg = thread?.messages
      ?.slice().reverse()
      .find((m) =>
        m.role === "assistant" &&
        (m.content || "").trim().length > 0 &&
        !String(m.content).startsWith("__STATUS__:")
      );
    const text = (msg?.content || "").trim();
    if (!text || text === lastSpokenRef.current) return;
    lastSpokenRef.current = text;
    await ttsSpeak(text, vs);
    if (vs.autoListenAfterSpeak) {
      const start = (window as any).__nikolai_voice_start;
      if (typeof start === "function") setTimeout(() => { try { start(); } catch {} }, 250);
    }
  } catch { }
}
```

## 4) isSpeaking flag / guard against overlap
There is no `isSpeaking` flag or guard in `ttsSpeak()` or in `VoicePanel` to prevent overlapping calls. The only protection is `stopCurrentAudio()` at the top of `ttsSpeak()`, which stops any existing audio whenever a new call begins:
```ts
export async function ttsSpeak(text: string, settings: VoiceSettings): Promise<void> {
  console.log("[TTS] speak request:", text.slice(0, 120));
  stopCurrentAudio();
  ...
}
```
So overlapping calls will stop the currently playing audio when the next call starts.

## 5) autoListenAfterSpeak timing
### App.tsx
`maybeAutoSpeakLastAssistant` awaits `ttsSpeak(text, vs)` and then starts listening 250ms later if enabled:
```ts
await ttsSpeak(text, vs);
if (vs.autoListenAfterSpeak) {
  const start = (window as any).__nikolai_voice_start;
  if (typeof start === "function") setTimeout(() => { try { start(); } catch {} }, 250);
}
```

### VoicePanel.tsx
Within `startRec()`’s `rec.onstop`, auto-speak is awaited, and auto-listen is scheduled 300ms later if enabled:
```ts
if (s.autoSpeak) {
  const speakFn = (window as any).__nikolai_tts_last;
  if (typeof speakFn === "function") {
    try {
      setStatus("Speaking…");
      await speakFn();
      setStatus("Done speaking.");
    } catch { /* ignore TTS errors — don't break the loop */ }
  }
}
if (s.autoListenAfterSpeak) {
  setTimeout(() => startRec().catch(() => {}), 300);
}
```

## 6) try/catch that swallows TTS errors
Yes. In `VoicePanel.tsx` the autoSpeak block wraps `speakFn()` in a `try/catch` that ignores errors:
```ts
if (s.autoSpeak) {
  const speakFn = (window as any).__nikolai_tts_last;
  if (typeof speakFn === "function") {
    try {
      setStatus("Speaking…");
      await speakFn();
      setStatus("Done speaking.");
    } catch { /* ignore TTS errors — don't break the loop */ }
  }
}
```

Additionally, `maybeAutoSpeakLastAssistant` in `App.tsx` wraps the entire function body in `try { ... } catch { }`, which silently swallows any errors:
```ts
async function maybeAutoSpeakLastAssistant(chatId?: string) {
  try {
    ...
    await ttsSpeak(text, vs);
    ...
  } catch { }
}
```

## 7) currentAudio and currentBlobUrl scope
They are module-level variables in `src/lib/ttsClient.ts`, shared across all calls (including overlapping or recursive calls):
```ts
let currentAudio: HTMLAudioElement | null = null;
let currentBlobUrl: string | null = null;
```
These are not scoped inside `ttsSpeak()`.
