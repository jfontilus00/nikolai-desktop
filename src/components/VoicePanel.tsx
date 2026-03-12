import { useEffect, useRef, useState } from "react";
import { loadVoiceSettings, saveVoiceSettings, type VoiceSettings } from "../lib/voiceSettings";
import { sttTranscribe, sttPing } from "../lib/sttClient";
import { ttsSpeak, ttsStop, stopTTS } from "../lib/ttsClient";
import { loadChats, loadActiveChatId } from "../lib/storage";

// Tauri invoke guard
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI__;
let tauriInvoke: typeof import("@tauri-apps/api/tauri").invoke | null = null;
if (isTauri) {
  import("@tauri-apps/api/tauri").then((m) => { tauriInvoke = m.invoke; }).catch(() => {});
}

type Props = {
  onInsertToComposer?: (text: string) => void;
};

type Phase = "idle" | "ready" | "listening" | "transcribing";

// ── Voice server types (mirrors voice.rs) ─────────────────────────────────────
type ServerInfo = {
  running: boolean;
  port: number;
  exe_exists: boolean;
  model_exists: boolean;
  exe_path: string;
  model_path: string;
};
type PiperStatus = {
  exe_exists: boolean;
  model_exists: boolean;
  exe_path: string;
  model_path: string;
  note: string;
};
type VoiceServerStatus = {
  whisper: ServerInfo;
  piper: PiperStatus;
  data_dir: string;
};
type DownloadInfo = {
  whisper_exe_url: string;
  whisper_model_url: string;
  piper_exe_url: string;
  piper_model_url: string;
  piper_config_url: string;
  total_mb_approx: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function looksLikeGarbage(text: string) {
  const t = (text || "").trim();
  if (!t) return true;
  if (t.length < 2) return true;
  if (/^(i['’]?m sorry[\.\s]*){2,}$/i.test(t)) return true;
  // Whisper silence tokens — must NEVER be sent to the AI as chat messages.
  // sttTranscribe() already throws on these, but this is a second safety net.
  if (/\[BLANK_AUDIO\]/i.test(t)) return true;
  if (/^\(silence\)$|^\[noise\]$|^\[Music\]$/i.test(t)) return true;
  // Pure punctuation / whitespace — nothing useful to send
  if (/^[.,!?\s]+$/.test(t)) return true;
  return false;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

async function playReadyTone(settings: VoiceSettings) {
  if (!settings.readyToneEnabled) return;
  const ms  = clamp(Number(settings.readyToneMs || 180), 60, 600);
  const hz  = clamp(Number(settings.readyToneHz || 880), 200, 2000);
  const vol = clamp(Number(settings.readyToneVolume || 0.14), 0.01, 0.4);
  try {
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
    if (!AudioCtx) return;
    const ctx  = new AudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = hz;
    gain.gain.value = vol;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    await new Promise<void>((r) => setTimeout(r, ms));
    try { osc.stop(); }  catch {}
    try { osc.disconnect(); }  catch {}
    try { gain.disconnect(); } catch {}
    try { await ctx.close(); } catch {}
  } catch {}
}

// ── Server status indicator ───────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${
        ok ? "bg-emerald-400" : "bg-red-400/70"
      }`}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function VoicePanel({ onInsertToComposer }: Props) {
  const [s, setS] = useState<VoiceSettings>(() => loadVoiceSettings());
  const [status, setStatus] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [recording, setRecording] = useState(false);

  const chunksRef = useRef<BlobPart[]>([]);
  const recRef    = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const vadIntervalRef     = useRef<number | null>(null);
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const analyserRef        = useRef<AnalyserNode | null>(null);
  const vadSpeechDetectedRef = useRef(false);
  const vadSilenceAccumRef   = useRef(0);
  const vadStartedAtRef      = useRef(0);

  const [lastTranscript, setLastTranscript] = useState("");
  const [micLevel, setMicLevel] = useState(0); // 0-1, updated from VAD RMS loop
  const [vadAdvanced, setVadAdvanced] = useState(false);

  // ── V4: Voice server state ──────────────────────────────────────────────────
  const [serverStatus, setServerStatus] = useState<VoiceServerStatus | null>(null);
  const [serverBusy, setServerBusy]     = useState(false);
  const [serverMsg, setServerMsg]       = useState<string | null>(null);
  const [dlInfo, setDlInfo]             = useState<DownloadInfo | null>(null);
  const [showDlInfo, setShowDlInfo]     = useState(false);

  useEffect(() => { saveVoiceSettings(s); }, [s]);

  // Poll server status every 5s when Tauri is available
  useEffect(() => {
    if (!isTauri) return;
    const refresh = async () => {
      try {
        const st = await tauriInvoke!<VoiceServerStatus>("voice_status");
        setServerStatus(st);
      } catch {}
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  // Expose voice hooks for App.tsx
  useEffect(() => {
    (window as any).__nikolai_voice_start = () => startRec().catch(() => {});
    (window as any).__nikolai_voice_stop  = () => stopRec().catch(() => {});
    return () => {
      delete (window as any).__nikolai_voice_start;
      delete (window as any).__nikolai_voice_stop;
    };
  }, [recording, s]); // eslint-disable-line react-hooks/exhaustive-deps

  // PTT hotkey
  useEffect(() => {
    if (!s.pttEnabled) return;
    let down = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.key !== (s.pttKey || "F9")) return;
      const el = document.activeElement as any;
      if (["input", "textarea"].includes(el?.tagName?.toLowerCase())) return;
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
      cleanupVad();
    };
  }, [s.pttEnabled, s.pttKey, recording]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup VAD on component unmount
  useEffect(() => {
    return () => {
      cleanupVad();
    };
  }, []);

  function cleanupVad() {
    try {
      if (vadIntervalRef.current != null) { window.clearInterval(vadIntervalRef.current); vadIntervalRef.current = null; }
    } catch {}
    analyserRef.current = null;
    try { if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {}); } catch {}
    audioCtxRef.current = null;
    vadSpeechDetectedRef.current = false;
    vadSilenceAccumRef.current   = 0;
    vadStartedAtRef.current      = 0;
    setMicLevel(0);
  }

  // Ping function disabled — unused variable removed
  // async function ping(url: string) {
  //   setStatus(null);
  //   try {
  //     const r = await fetch(url, { method: "GET" });
  //     setStatus(`Ping OK: ${r.status} ${url}`);
  //   } catch (e: any) {
  //     setStatus(`Ping FAILED: ${url} — ${e?.message || String(e)}`);
  //   }
  // }

  function setupVad(stream: MediaStream) {
    cleanupVad();
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
      const src     = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      vadSpeechDetectedRef.current = false;
      vadSilenceAccumRef.current   = 0;
      vadStartedAtRef.current      = Date.now();
      const tickMs = 100;
      vadIntervalRef.current = window.setInterval(() => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms       = Math.sqrt(sum / data.length);
        setMicLevel(Math.min(1, rms * 12)); // scale 0-1 for display (rms ~0-0.08 in normal speech)
        const threshold = clamp(Number(s.vadThreshold || 0.02), 0.005, 0.2);
        const silenceMs = clamp(Number(s.vadSilenceMs  || 900),  200, 4000);
        const minMs     = clamp(Number(s.vadMinSpeechMs || 600), 0,   5000);
        const elapsed   = Date.now() - vadStartedAtRef.current;
        if (rms > threshold) { vadSpeechDetectedRef.current = true; vadSilenceAccumRef.current = 0; return; }
        if (vadSpeechDetectedRef.current && elapsed >= minMs) {
          vadSilenceAccumRef.current += tickMs;
          if (vadSilenceAccumRef.current >= silenceMs) stopRec().catch(() => {});
        }
      }, tickMs);
    } catch {}
  }

  async function startRec() {
    stopTTS();

    // Activate voice session so App.tsx TTS triggers are enabled
    const activate = (window as any).__nikolai_voice_session_start;
    if (typeof activate === "function") activate();

    if (recording) return;
    setStatus(null); setLastTranscript("");
    try { ttsStop(); } catch {}
    setPhase("ready"); setStatus("Ready…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      await playReadyTone(s);
      if (s.vadEnabled) setupVad(stream);
      else cleanupVad();
      const rec = new MediaRecorder(stream);
      recRef.current   = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        try {
          cleanupVad();
          setPhase("transcribing"); setStatus("Transcribing…");
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
          const text = await sttTranscribe(blob, s);
          setLastTranscript(text);
          if (looksLikeGarbage(text)) {
            setPhase("idle"); setStatus("STT returned low-confidence text. Try speaking closer to the mic.");
            return;
          }
          if (s.autoSend) {
            const fn = (window as any).__nikolai_send;
            if (typeof fn === "function") { fn(text); setPhase("idle"); setStatus("Transcript auto-sent."); return; }
            onInsertToComposer?.(text.endsWith(" ") ? text : text + " ");
            setPhase("idle"); setStatus("Auto-send enabled, but send() hook not found. Inserted into composer.");
            return;
          }
          onInsertToComposer?.(text.endsWith(" ") ? text : text + " ");
          setPhase("idle"); setStatus("Transcript inserted into composer.");
          // autoListenAfterSpeak: if enabled, wait for TTS to finish then re-listen
          if (s.autoSpeak) {
            const speakFn = (window as any).__nikolai_tts_last;
            console.log("[PANEL-SPEAK:1] autoSpeak block entered, speakFn=", typeof (window as any).__nikolai_tts_last);
            if (typeof speakFn === "function") {
              try {
                setStatus("Speaking…");
                console.log("[PANEL-SPEAK:2] calling speakFn");
                await speakFn();
                console.log("[PANEL-SPEAK:3] speakFn done");
                setStatus("Done speaking.");
              } catch (e) {
                console.log("[PANEL-SPEAK:ERR]", e);
                setStatus(`Speech failed — check TTS server is running.`);
              } /* ignore TTS errors — don't break the loop */
            }
          }
          if (s.autoListenAfterSpeak) {
            setTimeout(() => startRec().catch(() => {}), 300);
          }
        } catch (e: any) {
          setPhase("idle"); setStatus(e?.message || String(e));

          // Auto-recover microphone when continuous mode enabled
          const s = loadVoiceSettings();
          if (s.autoListenAfterSpeak) {
            setTimeout(() => {
              try {
                startRec();
              } catch {}
            }, 500);
          }
        }
      };
      rec.start();
      setRecording(true);
      setPhase("listening");
      setStatus(s.vadEnabled ? "Listening… (VAD will stop on silence)" : "Listening… (click Stop)");
    } catch (e: any) {
      cleanupVad(); setPhase("idle");
      setStatus(`Mic error: ${e?.message || String(e)}. Windows Settings → Privacy → Microphone → allow desktop apps.`);
    }
  }

  async function stopRec() {
    // Deactivate voice session — text chat will no longer trigger TTS
    const deactivate = (window as any).__nikolai_voice_session_end;
    if (typeof deactivate === "function") deactivate();

    try { recRef.current?.stop(); }    catch {}
    try { streamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}
    recRef.current = null; streamRef.current = null;
    cleanupVad(); setRecording(false);
    if (phase !== "transcribing") setPhase("idle");
  }

  async function speakCustom() {
    const text = prompt("Text to speak", lastTranscript || "Hello, I am NikolAi.");
    if (!text) return;
    setStatus("Speaking…");
    try { await ttsSpeak(text, s); setStatus("Done."); }
    catch (e: any) { setStatus(e?.message || String(e)); }
  }

  // ── V4: Server management ───────────────────────────────────────────────────

  async function startServers() {
    if (!tauriInvoke) return;
    setServerBusy(true); setServerMsg(null);
    try {
      const msg = await tauriInvoke<string>("voice_start_servers");
      setServerMsg(msg);
      // Refresh status
      const st = await tauriInvoke<VoiceServerStatus>("voice_status");
      setServerStatus(st);
    } catch (e: any) {
      setServerMsg(`Error: ${e?.message || String(e)}`);
    } finally {
      setServerBusy(false);
    }
  }

  async function stopServers() {
    if (!tauriInvoke) return;
    setServerBusy(true);
    try {
      await tauriInvoke("voice_stop_servers");
      const st = await tauriInvoke<VoiceServerStatus>("voice_status");
      setServerStatus(st);
      setServerMsg("Servers stopped.");
    } catch (e: any) {
      setServerMsg(`Error: ${e?.message || String(e)}`);
    } finally {
      setServerBusy(false);
    }
  }

  async function loadDownloadInfo() {
    if (!tauriInvoke) return;
    try {
      const info = await tauriInvoke<DownloadInfo>("voice_download_info");
      setDlInfo(info);
      setShowDlInfo(true);
    } catch {}
  }

  const indicator =
    phase === "ready"        ? "Ready…"        :
    phase === "listening"    ? "Listening…"    :
    phase === "transcribing" ? "Transcribing…" : "Idle";

  const whisperOk = serverStatus?.whisper.running ?? false;
  const piperOk   = (serverStatus?.piper.exe_exists && serverStatus?.piper.model_exists) ?? false;
  const whisperReady = serverStatus?.whisper.exe_exists && serverStatus?.whisper.model_exists;
  const piperReady   = serverStatus?.piper.exe_exists   && serverStatus?.piper.model_exists;

  return (
    <div className="space-y-3">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold opacity-80">Voice (Local)</div>
        <div className="text-[11px] px-2 py-1 rounded border border-white/10 bg-white/5">
          {indicator}
        </div>
      </div>

      {/* ── V4: Server status panel ── */}
      {isTauri && (
        <div className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-2">
          <div className="text-xs font-semibold opacity-80">Voice Servers</div>

          <div className="space-y-1.5">
            {/* Whisper */}
            <div className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <StatusDot ok={whisperOk} />
                <span className="opacity-70">ASR (whisper-server)</span>
                <span className="opacity-40 text-[10px]">:9900</span>
              </div>
              <span className={whisperOk ? "text-emerald-400/70" : "text-white/30"}>
                {whisperOk ? "running" : (whisperReady ? "stopped" : "not installed")}
              </span>
            </div>

            {/* Piper — direct mode, no HTTP server, show file-ready status */}
            <div className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <StatusDot ok={piperReady ?? false} />
                <span className="opacity-70">TTS (piper)</span>
                <span className="opacity-40 text-[10px]">direct</span>
              </div>
              <span className={piperReady ? "text-emerald-400/70" : "text-amber-400/70"}>
                {piperReady ? "ready ✓" : "model missing"}
              </span>
            </div>
          </div>

          {serverStatus && (
            <div className="text-[10px] opacity-40 break-all">
              Data: {serverStatus.data_dir}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              className="px-3 py-1.5 rounded bg-emerald-700/60 hover:bg-emerald-600/60 border border-emerald-500/30 text-xs font-semibold disabled:opacity-50"
              onClick={startServers}
              disabled={serverBusy || !whisperReady}
              title={!whisperReady ? "Install whisper-server first (see download info)" : "Start whisper-server (piper is always direct)"}
            >
              {serverBusy ? "Starting…" : "▶ Start servers"}
            </button>

            <button
              type="button"
              className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 border border-white/10 text-xs disabled:opacity-50"
              onClick={stopServers}
              disabled={serverBusy || (!whisperOk && !piperOk)}
            >
              ■ Stop servers
            </button>
          </div>

          {/* Not installed — show download instructions */}
          {(!whisperReady || !piperReady) && (
            <div className="border border-amber-400/20 rounded-lg bg-amber-500/5 p-2.5 space-y-2">
              <div className="text-[11px] text-amber-200/80 font-medium">
                Voice pack not installed
              </div>
              <div className="text-[11px] text-amber-200/60 leading-relaxed">
                Download whisper-server + piper + models (~195 MB total).
                One-time download, then voice works offline forever.
              </div>

              <button
                type="button"
                className="text-[10px] text-amber-300/70 underline hover:text-amber-300"
                onClick={loadDownloadInfo}
              >
                Show download URLs
              </button>

              {showDlInfo && dlInfo && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-[10px] opacity-50 uppercase tracking-widest">
                    Download these files into: {serverStatus?.data_dir}
                  </div>

                  {[
                    { label: "whisper-server (.exe)", url: dlInfo.whisper_exe_url, rename: "whisper-server.exe" },
                    { label: "Whisper base-en model", url: dlInfo.whisper_model_url, rename: "ggml-base.en.bin" },
                    { label: "piper (.exe)", url: dlInfo.piper_exe_url, rename: "piper.exe (extract from zip)" },
                    { label: "Piper voice model", url: dlInfo.piper_model_url, rename: "en_US-lessac-medium.onnx" },
                    { label: "Piper voice config", url: dlInfo.piper_config_url, rename: "en_US-lessac-medium.onnx.json" },
                  ].map((f) => (
                    <div key={f.label} className="text-[10px] space-y-0.5">
                      <div className="text-white/60 font-medium">{f.label}</div>
                      <div className="font-mono text-white/35 break-all">{f.rename}</div>
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-indigo-300/70 hover:text-indigo-200 break-all underline"
                      >
                        {f.url}
                      </a>
                    </div>
                  ))}

                  <div className="text-[10px] text-amber-300/60 pt-1">
                    After downloading, click "▶ Start servers" above.
                  </div>
                </div>
              )}
            </div>
          )}

          {serverMsg && (
            <div className={`text-[11px] ${serverMsg.startsWith("Error") ? "text-red-400" : "text-emerald-400/80"}`}>
              {serverMsg}
            </div>
          )}
        </div>
      )}

      {/* ── STT settings ── */}
      <div className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold opacity-80">STT (Whisper)</div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/30 text-emerald-300/80">
            endpoint: /inference
          </span>
        </div>

        <label className="block text-xs opacity-70">Base URL</label>
        <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
          value={s.sttBaseUrl} onChange={(e) => setS({ ...s, sttBaseUrl: e.target.value })} />

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs opacity-70">Language (blank = auto)</label>
            <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
              value={s.sttLanguage} onChange={(e) => setS({ ...s, sttLanguage: e.target.value })}
              placeholder="e.g. fr or en" />
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
          <div><label className="block text-xs opacity-70">Tone ms</label>
            <input type="number" step="10" className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none"
              value={s.readyToneMs} onChange={(e) => setS({ ...s, readyToneMs: Number(e.target.value) })} /></div>
          <div><label className="block text-xs opacity-70">Tone Hz</label>
            <input type="number" step="10" className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none"
              value={s.readyToneHz} onChange={(e) => setS({ ...s, readyToneHz: Number(e.target.value) })} /></div>
          <div><label className="block text-xs opacity-70">Volume</label>
            <input type="number" step="0.01" className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none"
              value={s.readyToneVolume} onChange={(e) => setS({ ...s, readyToneVolume: Number(e.target.value) })} /></div>
        </div>

        <div className="border-t border-white/10 pt-2 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold opacity-80">VAD (auto-stop)</div>
            <button
              type="button"
              className="text-[10px] opacity-40 hover:opacity-70"
              onClick={() => setVadAdvanced((v) => !v)}
            >
              {vadAdvanced ? "Simple ▲" : "Advanced ▼"}
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs opacity-80">
            <input type="checkbox" checked={Boolean(s.vadEnabled)} onChange={(e) => setS({ ...s, vadEnabled: e.target.checked })} />
            Auto-stop on silence
          </label>

          {!vadAdvanced ? (
            /* ── Preset picker ── */
            <div className="space-y-1">
              <label className="block text-xs opacity-70">Environment</label>
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  { label: "Quiet",  desc: "Home/office",   threshold: 0.01, silenceMs: 700,  minSpeechMs: 400  },
                  { label: "Normal", desc: "Typical",       threshold: 0.02, silenceMs: 900,  minSpeechMs: 600  },
                  { label: "Noisy",  desc: "Loud room",     threshold: 0.05, silenceMs: 1200, minSpeechMs: 800  },
                ] as const).map((p) => {
                  const active =
                    s.vadThreshold   === p.threshold &&
                    s.vadSilenceMs   === p.silenceMs  &&
                    s.vadMinSpeechMs === p.minSpeechMs;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setS({ ...s, vadThreshold: p.threshold, vadSilenceMs: p.silenceMs, vadMinSpeechMs: p.minSpeechMs })}
                      className={`px-2 py-2 rounded-md border text-xs text-left transition-colors ${
                        active
                          ? "border-blue-400/50 bg-blue-500/15 text-blue-300"
                          : "border-white/10 bg-white/5 hover:bg-white/10 opacity-70"
                      }`}
                    >
                      <div className="font-semibold">{p.label}</div>
                      <div className="text-[10px] opacity-60">{p.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            /* ── Advanced raw controls ── */
            <div className="grid grid-cols-3 gap-2">
              <div><label className="block text-xs opacity-70">Threshold</label>
                <input type="number" step="0.005" className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none"
                  value={s.vadThreshold} onChange={(e) => setS({ ...s, vadThreshold: Number(e.target.value) })} /></div>
              <div><label className="block text-xs opacity-70">Silence ms</label>
                <input type="number" step="100" className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none"
                  value={s.vadSilenceMs} onChange={(e) => setS({ ...s, vadSilenceMs: Number(e.target.value) })} /></div>
              <div><label className="block text-xs opacity-70">Min speech ms</label>
                <input type="number" step="100" className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none"
                  value={s.vadMinSpeechMs} onChange={(e) => setS({ ...s, vadMinSpeechMs: Number(e.target.value) })} /></div>
            </div>
          )}
        </div>

        <div className="border-t border-white/10 pt-2 space-y-2">
          <div className="text-xs font-semibold opacity-80">Push-to-talk</div>
          <label className="flex items-center gap-2 text-xs opacity-80">
            <input type="checkbox" checked={Boolean(s.pttEnabled)} onChange={(e) => setS({ ...s, pttEnabled: e.target.checked })} />
            Enable hotkey (hold {s.pttKey || "F9"} to talk)
          </label>
          <label className="block text-xs opacity-70">Hotkey</label>
          <input className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none"
            value={s.pttKey} onChange={(e) => setS({ ...s, pttKey: e.target.value })} placeholder="F9" />
        </div>

        {/* ── Mic level meter — only visible while recording ── */}
        {recording && (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full transition-none"
                  style={{
                    width: `${Math.round(micLevel * 100)}%`,
                    background: micLevel > 0.75
                      ? "rgb(248 113 113)"       // red  — clipping
                      : micLevel > 0.4
                      ? "rgb(251 191 36)"        // amber — loud
                      : "rgb(52 211 153)",       // green — normal
                  }}
                />
              </div>
              <span className="text-[10px] opacity-40 w-6 text-right tabular-nums">
                {Math.round(micLevel * 100)}
              </span>
            </div>
            <div className="text-[10px] opacity-40">
              {micLevel < 0.05
                ? "No signal — check mic privacy settings"
                : micLevel > 0.75
                ? "Too loud — move mic further away"
                : "Good signal ✓"}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
            onClick={async () => {
              setStatus("Pinging whisper-server…");
              try {
                const msg = await sttPing(s.sttBaseUrl);
                setStatus(msg);
              } catch (e: any) {
                setStatus(`Ping FAILED: ${e?.message || String(e)}`);
              }
            }}>
            Ping STT
          </button>
          {!recording ? (
            <button type="button" className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-sm font-semibold" onClick={startRec}>
              🎙 Record
            </button>
          ) : (
            <button type="button" className="px-3 py-2 rounded-md bg-red-600 hover:bg-red-500 text-sm font-semibold" onClick={stopRec}>
              ⏹ Stop
            </button>
          )}
        </div>

        {lastTranscript && <div className="text-xs opacity-70 break-words">Transcript: {lastTranscript}</div>}
      </div>

      {/* ── TTS settings ── */}
      <div className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold opacity-80">TTS (Piper)</div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/30 text-indigo-300/80">
            direct mode — no HTTP server
          </span>
        </div>

        <div className="text-[11px] opacity-55 leading-relaxed">
          Piper is called directly by the app — no HTTP server needed.
          Make sure <code className="bg-white/10 px-1 rounded">voice/piper/piper.exe</code> and
          <code className="bg-white/10 px-1 rounded ml-1">voice/voices/*.onnx</code> are present.
        </div>

        <label className="block text-xs opacity-70">Speed</label>
        <input type="number" step="0.1" className="w-full rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
          value={s.ttsSpeed} onChange={(e) => setS({ ...s, ttsSpeed: Number(e.target.value) })} />

        <div className="flex gap-2 flex-wrap">
          {/* Test TTS via direct Tauri command — replaces "Ping TTS" HTTP ping */}
          <button type="button" className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
            onClick={async () => {
              setStatus("Testing TTS…");
              try {
                if (isTauri && tauriInvoke) {
                  const wavBytes = await tauriInvoke<number[]>("voice_tts_speak", { text: "Hello, NikolAi voice is working." });
                  const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
                  const url  = URL.createObjectURL(blob);
                  const audio = new Audio(url);
                  audio.onended = () => URL.revokeObjectURL(url);
                  await audio.play();
                  setStatus("TTS OK — piper is working ✓");
                } else {
                  await ttsSpeak("Hello, NikolAi voice is working.", s);
                  setStatus("TTS OK ✓");
                }
              } catch (e: any) { setStatus(`TTS failed: ${e?.message || String(e)}`); }
            }}>
            Test TTS
          </button>
          <button type="button" className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-sm font-semibold"
            onClick={async () => {
              try {
                const chats    = loadChats();
                const activeId = loadActiveChatId();
                const thread   = chats.find((c) => c.id === activeId) || chats[0];
                const msg      = thread?.messages?.slice().reverse().find((m) => m.role === "assistant" && (m.content || "").trim().length > 0);
                const text     = msg?.content || "";
                if (!text.trim()) return setStatus("No assistant message found to speak.");
                setStatus("Speaking…");
                await ttsSpeak(text, s);
                setStatus("Done.");
              } catch (e: any) { setStatus(e?.message || String(e)); }
            }}>
            🔊 Speak last assistant
          </button>
          <button type="button" className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
            onClick={() => { try { ttsStop(); } catch {} }}>
            ⏹ Stop
          </button>
          <button type="button" className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
            onClick={speakCustom}>
            Speak…
          </button>
        </div>
      </div>

      {status && <div className="text-xs text-amber-300">{status}</div>}

      {status?.toLowerCase().includes("mic error") && (
        <button
          className="mt-2 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold transition-colors"
          onClick={startRec}
          aria-label="Retry microphone permission"
        >
          Retry Mic Permission
        </button>
      )}

      {phase === "transcribing" && (
        <div className="flex items-center gap-2 text-xs text-white/50 mt-2">
          <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          <span>Transcribing speech…</span>
        </div>
      )}
    </div>
  );
}
