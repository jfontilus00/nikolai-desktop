import { useEffect, useRef, useState } from "react";
import { loadVoiceSettings, saveVoiceSettings, type VoiceSettings } from "../lib/voiceSettings";
import { sttTranscribe } from "../lib/sttClient";
import { ttsSpeak, ttsStop } from "../lib/ttsClient";
import { loadChats, loadActiveChatId } from "../lib/storage";

type Props = {
  onInsertToComposer?: (text: string) => void;
};

type Phase = "idle" | "ready" | "listening" | "transcribing";

function looksLikeGarbage(text: string) {
  const t = (text || "").trim();
  if (!t) return true;
  if (t.length < 2) return true;
  if (/^(i['â€™]?m sorry[\.\s]*){2,}$/i.test(t)) return true;
  return false;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

async function playReadyTone(settings: VoiceSettings) {
  if (!settings.readyToneEnabled) return;

  const ms = clamp(Number(settings.readyToneMs || 180), 60, 600);
  const hz = clamp(Number(settings.readyToneHz || 880), 200, 2000);
  const vol = clamp(Number(settings.readyToneVolume || 0.14), 0.01, 0.4);

  try {
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = hz;
    gain.gain.value = vol;

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();

    await new Promise<void>((r) => setTimeout(r, ms));

    try { osc.stop(); } catch {}
    try { osc.disconnect(); } catch {}
    try { gain.disconnect(); } catch {}
    try { await ctx.close(); } catch {}
  } catch {
    // If tone fails (autoplay policy etc), just continue.
  }
}

export default function VoicePanel({ onInsertToComposer }: Props) {
  const [s, setS] = useState<VoiceSettings>(() => loadVoiceSettings());
  const [status, setStatus] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  const [recording, setRecording] = useState(false);
  const chunksRef = useRef<BlobPart[]>([]);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // VAD internals
  const vadIntervalRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadSpeechDetectedRef = useRef(false);
  const vadSilenceAccumRef = useRef(0);
  const vadStartedAtRef = useRef(0);

  const [lastTranscript, setLastTranscript] = useState<string>("");

  useEffect(() => saveVoiceSettings(s), [s]);

  // Expose voice start/stop so App.tsx can trigger auto-listen after TTS
  useEffect(() => {
    (window as any).__nikolai_voice_start = () => startRec().catch(() => {});
    (window as any).__nikolai_voice_stop = () => stopRec().catch(() => {});
    return () => {
      if ((window as any).__nikolai_voice_start) delete (window as any).__nikolai_voice_start;
      if ((window as any).__nikolai_voice_stop) delete (window as any).__nikolai_voice_stop;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, s]);

  // Push-to-talk hotkey (hold F9 by default) â€” only active while Voice tab is open
  useEffect(() => {
    if (!s.pttEnabled) return;

    let down = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key !== (s.pttKey || "F9")) return;

      const el = document.activeElement as any;
      const tag = (el?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      e.preventDefault();
      if (down) return;
      down = true;

      if (!recording) startRec().catch(() => {});
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== (s.pttKey || "F9")) return;
      e.preventDefault();
      down = false;
      if (recording) stopRec().catch(() => {});
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.pttEnabled, s.pttKey, recording]);

  function cleanupVad() {
    try {
      if (vadIntervalRef.current != null) {
        window.clearInterval(vadIntervalRef.current);
        vadIntervalRef.current = null;
      }
    } catch {}

    analyserRef.current = null;

    try {
      if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
    } catch {}
    audioCtxRef.current = null;

    vadSpeechDetectedRef.current = false;
    vadSilenceAccumRef.current = 0;
    vadStartedAtRef.current = 0;
  }

  async function ping(url: string) {
    setStatus(null);
    try {
      const r = await fetch(url, { method: "GET" });
      setStatus(`Ping OK: ${r.status} ${url}`);
    } catch (e: any) {
      setStatus(`Ping FAILED: ${url} â€” ${e?.message || String(e)}`);
    }
  }

  function setupVad(stream: MediaStream) {
    cleanupVad();
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;

      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;

      src.connect(analyser);

      const data = new Uint8Array(analyser.fftSize);
      vadSpeechDetectedRef.current = false;
      vadSilenceAccumRef.current = 0;
      vadStartedAtRef.current = Date.now();

      const tickMs = 100;
      vadIntervalRef.current = window.setInterval(() => {
        const a = analyserRef.current;
        if (!a) return;

        a.getByteTimeDomainData(data);

        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);

        const threshold = clamp(Number(s.vadThreshold || 0.02), 0.005, 0.2);
        const silenceMs = clamp(Number(s.vadSilenceMs || 900), 200, 4000);
        const minSpeechMs = clamp(Number(s.vadMinSpeechMs || 600), 0, 5000);

        const elapsed = Date.now() - vadStartedAtRef.current;

        if (rms > threshold) {
          vadSpeechDetectedRef.current = true;
          vadSilenceAccumRef.current = 0;
          return;
        }

        if (vadSpeechDetectedRef.current && elapsed >= minSpeechMs) {
          vadSilenceAccumRef.current += tickMs;
          if (vadSilenceAccumRef.current >= silenceMs) {
            stopRec().catch(() => {});
          }
        }
      }, tickMs);
    } catch {
      // skip VAD if AudioContext fails
    }
  }

  async function startRec() {
    if (recording) return;

    setStatus(null);
    setLastTranscript("");

    // stop any TTS so mic doesn't catch it
    try { ttsStop(); } catch {}

    setPhase("ready");
    setStatus("Readyâ€¦");

    try {
      // Request mic first (permission prompt), then tone, then start actual recording.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Ready tone BEFORE recording starts (not captured)
      await playReadyTone(s);

      if (s.vadEnabled) setupVad(stream);
      else cleanupVad();

      const rec = new MediaRecorder(stream);
      recRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        try {
          cleanupVad();
          setPhase("transcribing");
          setStatus("Transcribingâ€¦");

          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
          const text = await sttTranscribe(blob, s);
          setLastTranscript(text);

          if (looksLikeGarbage(text)) {
            setPhase("idle");
            setStatus("STT returned low-confidence text. Try speaking closer to the mic, or reduce background noise.");
            return;
          }

          if (s.autoSend) {
            const fn = (window as any).__nikolai_send;
            if (typeof fn === "function") {
              fn(text);
              setPhase("idle");
              setStatus("Transcript auto-sent.");
              return;
            }
            onInsertToComposer?.((text.endsWith(" ") ? text : text + " "));
            setPhase("idle");
            setStatus("Auto-send enabled, but send() hook not found. Inserted into composer.");
            return;
          }

          onInsertToComposer?.((text.endsWith(" ") ? text : text + " "));
          setPhase("idle");
          setStatus("Transcript inserted into composer.");
        } catch (e: any) {
          setPhase("idle");
          setStatus(e?.message || String(e));
        }
      };

      rec.start();
      setRecording(true);
      setPhase("listening");
      setStatus(s.vadEnabled ? "Listeningâ€¦ (VAD will stop on silence)" : "Listeningâ€¦ (click Stop)");
    } catch (e: any) {
      cleanupVad();
      setPhase("idle");
      setStatus(`Mic error: ${e?.message || String(e)}. Windows Settings â†’ Privacy & security â†’ Microphone â†’ allow desktop apps.`);
    }
  }

  async function stopRec() {
    try { recRef.current?.stop(); } catch {}
    try { streamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}

    recRef.current = null;
    streamRef.current = null;

    cleanupVad();
    setRecording(false);

    // If user stops manually, we go idle (transcribe will run via onstop)
    if (phase !== "transcribing") setPhase("idle");
  }

  async function speakCustom() {
    const text = prompt("Text to speak", lastTranscript || "Hello");
    if (!text) return;
    setStatus("Speakingâ€¦");
    try {
      await ttsSpeak(text, s);
      setStatus("Done.");
    } catch (e: any) {
      setStatus(e?.message || String(e));
    }
  }

  const indicator =
    phase === "ready" ? "Readyâ€¦" :
    phase === "listening" ? "Listeningâ€¦" :
    phase === "transcribing" ? "Transcribingâ€¦" :
    "Idle";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold opacity-80">Voice (Offline)</div>
        <div className="text-[11px] px-2 py-1 rounded border border-white/10 bg-white/5 opacity-90">
          {indicator}
        </div>
      </div>

      <div className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-2">
        <div className="text-xs font-semibold opacity-80">STT (Whisper)</div>

        <label className="block text-xs opacity-70">Base URL</label>
        <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
          value={s.sttBaseUrl}
          onChange={(e) => setS({ ...s, sttBaseUrl: e.target.value })}
        />

        <label className="block text-xs opacity-70">Path</label>
        <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
          value={s.sttPath}
          onChange={(e) => setS({ ...s, sttPath: e.target.value })}
        />

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs opacity-70">Language (blank = auto)</label>
            <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
              value={s.sttLanguage}
              onChange={(e) => setS({ ...s, sttLanguage: e.target.value })}
              placeholder="e.g. fr or en (leave empty for auto)"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs opacity-70">Task</label>
            <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
              value={s.sttTask}
              onChange={(e) => setS({ ...s, sttTask: e.target.value })}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs opacity-80">
          <input type="checkbox" checked={Boolean(s.forceWav)} onChange={(e) => setS({ ...s, forceWav: e.target.checked })} />
          Force WAV (best compatibility)
        </label>

        <label className="flex items-center gap-2 text-xs opacity-80">
          <input type="checkbox" checked={Boolean(s.autoSend)} onChange={(e) => setS({ ...s, autoSend: e.target.checked })} />
          Auto-send transcript
        </label>

        <label className="flex items-center gap-2 text-xs opacity-80">
          <input type="checkbox" checked={Boolean(s.autoSpeak)} onChange={(e) => setS({ ...s, autoSpeak: e.target.checked })} />
          Auto-speak assistant replies
        </label>

        <label className="flex items-center gap-2 text-xs opacity-80">
          <input type="checkbox" checked={Boolean(s.autoListenAfterSpeak)} onChange={(e) => setS({ ...s, autoListenAfterSpeak: e.target.checked })} />
          Auto-listen after assistant speaks (walkie-talkie loop)
        </label>

        <label className="flex items-center gap-2 text-xs opacity-80">
          <input type="checkbox" checked={Boolean(s.readyToneEnabled)} onChange={(e) => setS({ ...s, readyToneEnabled: e.target.checked })} />
          Ready tone before listening
        </label>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-xs opacity-70">Tone ms</label>
            <input type="number" step="10"
              className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
              value={s.readyToneMs}
              onChange={(e) => setS({ ...s, readyToneMs: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="block text-xs opacity-70">Tone Hz</label>
            <input type="number" step="10"
              className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
              value={s.readyToneHz}
              onChange={(e) => setS({ ...s, readyToneHz: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="block text-xs opacity-70">Volume</label>
            <input type="number" step="0.01"
              className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
              value={s.readyToneVolume}
              onChange={(e) => setS({ ...s, readyToneVolume: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="border-t border-white/10 pt-2 space-y-2">
          <div className="text-xs font-semibold opacity-80">VAD (auto-stop)</div>

          <label className="flex items-center gap-2 text-xs opacity-80">
            <input type="checkbox" checked={Boolean(s.vadEnabled)} onChange={(e) => setS({ ...s, vadEnabled: e.target.checked })} />
            Enable VAD auto-stop on silence
          </label>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs opacity-70">Threshold</label>
              <input type="number" step="0.005"
                className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                value={s.vadThreshold}
                onChange={(e) => setS({ ...s, vadThreshold: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-xs opacity-70">Silence ms</label>
              <input type="number" step="100"
                className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                value={s.vadSilenceMs}
                onChange={(e) => setS({ ...s, vadSilenceMs: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-xs opacity-70">Min speech ms</label>
              <input type="number" step="100"
                className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
                value={s.vadMinSpeechMs}
                onChange={(e) => setS({ ...s, vadMinSpeechMs: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>

        <div className="border-t border-white/10 pt-2 space-y-2">
          <div className="text-xs font-semibold opacity-80">Push-to-talk</div>

          <label className="flex items-center gap-2 text-xs opacity-80">
            <input type="checkbox" checked={Boolean(s.pttEnabled)} onChange={(e) => setS({ ...s, pttEnabled: e.target.checked })} />
            Enable hotkey (hold {s.pttKey || "F9"} to talk)
          </label>

          <label className="block text-xs opacity-70">Hotkey</label>
          <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
            value={s.pttKey}
            onChange={(e) => setS({ ...s, pttKey: e.target.value })}
            placeholder="F9"
          />
        </div>

        <div className="flex gap-2">
          <button className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
            onClick={() => ping(`${s.sttBaseUrl.replace(/\/+$/, "")}/docs`)}
          >
            Ping STT
          </button>

          {!recording ? (
            <button className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-sm font-semibold" onClick={startRec}>
              ðŸŽ™ï¸ Record
            </button>
          ) : (
            <button className="px-3 py-2 rounded-md bg-red-600 hover:bg-red-500 text-sm font-semibold" onClick={stopRec}>
              â¹ Stop
            </button>
          )}
        </div>

        {lastTranscript ? <div className="text-xs opacity-70 break-words">Transcript: {lastTranscript}</div> : null}
      </div>

      <div className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-2">
        <div className="text-xs font-semibold opacity-80">TTS (Piper)</div>

        <label className="block text-xs opacity-70">Base URL</label>
        <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
          value={s.ttsBaseUrl}
          onChange={(e) => setS({ ...s, ttsBaseUrl: e.target.value })}
        />

        <label className="block text-xs opacity-70">Path</label>
        <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
          value={s.ttsPath}
          onChange={(e) => setS({ ...s, ttsPath: e.target.value })}
        />

        <label className="block text-xs opacity-70">Speed</label>
        <input type="number" step="0.1"
          className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
          value={s.ttsSpeed}
          onChange={(e) => setS({ ...s, ttsSpeed: Number(e.target.value) })}
        />

        <div className="flex gap-2">
          <button className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
            onClick={() => ping(`${s.ttsBaseUrl.replace(/\/+$/, "")}/health`)}
          >
            Ping TTS
          </button>

          <button className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-sm font-semibold"
            onClick={async () => {
              try {
                const chats = loadChats();
                const activeId = loadActiveChatId();
                const thread = chats.find((c) => c.id === activeId) || chats[0];
                const msg = thread?.messages?.slice().reverse().find((m) => m.role === "assistant" && (m.content || "").trim().length > 0);
                const text = msg?.content || "";
                if (!text.trim()) return setStatus("No assistant message found to speak.");
                setStatus("Speakingâ€¦");
                await ttsSpeak(text, s);
                setStatus("Done.");
              } catch (e: any) {
                setStatus(e?.message || String(e));
              }
            }}
          >
            ðŸ”Š Speak last assistant
          </button>

          <button className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
            onClick={() => { try { ttsStop(); } catch {} }}
          >
            â¹ Stop
          </button>

          <button className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
            onClick={speakCustom}
          >
            Speakâ€¦
          </button>
        </div>
      </div>

      {status ? <div className="text-xs text-amber-300">{status}</div> : null}
    </div>
  );
}