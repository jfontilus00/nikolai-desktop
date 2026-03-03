// ── Atelier NikolAi Desktop — Voice Manager ──────────────────────────────────
//
// ACTUAL directory layout (from user's %APPDATA%\com.timanou.nikolai\voice\):
//
//   voice/
//     whisper/
//       whisper-server.exe   ← ASR HTTP server
//       models/
//         ggml-base.en.bin   ← Whisper model (~150 MB)
//       ggml-base.dll, ggml-cpu.dll, whisper.dll, etc.
//     piper/
//       piper.exe            ← TTS CLI (NO HTTP server mode)
//       espeak-ng-data/      ← required data directory
//       espeak-ng.dll        ← required DLL
//       onnxruntime.dll      ← required DLL
//       piper_phonemize.dll  ← required DLL
//       voices/ (optional)
//     voices/
//       en_US-lessac-medium.onnx      ← Piper voice model (~40 MB)
//       en_US-lessac-medium.onnx.json ← Piper voice config
//
// NOTE: piper has NO HTTP server mode. TTS calls are made by spawning piper
// directly (stdin text → WAV file). The voice_tts_speak Tauri command handles
// this. The frontend receives WAV bytes and plays with HTMLAudioElement.
//
// Tauri commands:
//   voice_status          → VoiceServerStatus
//   voice_start_servers   → starts whisper-server only (piper needs no server)
//   voice_stop_servers    → kills whisper-server
//   voice_download_info   → returns download URLs + install instructions
//   voice_tts_speak       → synthesise text → WAV bytes

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::AppHandle;

struct WhisperProcess { child: Option<Child> }

lazy_static::lazy_static! {
  static ref WHISPER_PROC: Mutex<WhisperProcess> = Mutex::new(WhisperProcess { child: None });
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
  pub running:      bool,
  pub port:         u16,
  pub exe_exists:   bool,
  pub model_exists: bool,
  pub exe_path:     String,
  pub model_path:   String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiperStatus {
  pub exe_exists:   bool,
  pub model_exists: bool,
  pub exe_path:     String,
  pub model_path:   String,
  pub note:         String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceServerStatus {
  pub whisper:  ServerInfo,
  pub piper:    PiperStatus,
  pub data_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadInfo {
  pub whisper_exe_url:    String,
  pub whisper_model_url:  String,
  pub piper_zip_url:      String,
  pub piper_model_url:    String,
  pub piper_config_url:   String,
  pub piper_install_note: String,
  pub total_mb_approx:    u32,
}

// ── Path helpers (match actual directory layout) ──────────────────────────────

fn voice_data_dir(app: &AppHandle) -> PathBuf {
  app.path_resolver().app_data_dir()
    .unwrap_or_else(|| PathBuf::from("."))
    .join("voice")
}

// whisper-server.exe lives in voice/whisper/
fn whisper_exe(voice_dir: &PathBuf) -> PathBuf {
  #[cfg(target_os = "windows")]
  return voice_dir.join("whisper").join("whisper-server.exe");
  #[cfg(not(target_os = "windows"))]
  return voice_dir.join("whisper").join("whisper-server");
}

// Whisper model lives in voice/whisper/models/
fn whisper_model(voice_dir: &PathBuf) -> PathBuf {
  voice_dir.join("whisper").join("models").join("ggml-base.en.bin")
}

// whisper-server runs from voice/whisper/ so it finds its DLLs
fn whisper_run_dir(voice_dir: &PathBuf) -> PathBuf {
  voice_dir.join("whisper")
}

// piper.exe lives in voice/piper/
fn piper_exe(voice_dir: &PathBuf) -> PathBuf {
  #[cfg(target_os = "windows")]
  return voice_dir.join("piper").join("piper.exe");
  #[cfg(not(target_os = "windows"))]
  return voice_dir.join("piper").join("piper");
}

// piper runs from voice/piper/ so it finds espeak-ng.dll + espeak-ng-data/
fn piper_run_dir(voice_dir: &PathBuf) -> PathBuf {
  voice_dir.join("piper")
}

// Voice model lives in voice/voices/  (shared between piper subdirs)
fn piper_model(voice_dir: &PathBuf) -> PathBuf {
  voice_dir.join("voices").join("en_US-lessac-medium.onnx")
}

fn piper_config(voice_dir: &PathBuf) -> PathBuf {
  voice_dir.join("voices").join("en_US-lessac-medium.onnx.json")
}

// ── Download info ─────────────────────────────────────────────────────────────

fn download_info_inner() -> DownloadInfo {
  let note = concat!(
    "LAYOUT: Extract piper zip into voice/piper/ (all DLLs + espeak-ng-data/ must be there). ",
    "Extract whisper zip into voice/whisper/ (all DLLs must be there). ",
    "Put ggml-base.en.bin into voice/whisper/models/. ",
    "Put en_US-lessac-medium.onnx and .json into voice/voices/."
  ).to_string();

  #[cfg(target_os = "windows")]
  return DownloadInfo {
    whisper_exe_url:    "https://github.com/ggerganov/whisper.cpp/releases/latest".to_string(),
    whisper_model_url:  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin".to_string(),
    piper_zip_url:      "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip".to_string(),
    piper_model_url:    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx".to_string(),
    piper_config_url:   "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json".to_string(),
    piper_install_note: note,
    total_mb_approx:    200,
  };

  #[cfg(target_os = "macos")]
  return DownloadInfo {
    whisper_exe_url:    "https://github.com/ggerganov/whisper.cpp/releases/latest".to_string(),
    whisper_model_url:  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin".to_string(),
    piper_zip_url:      "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_aarch64.tar.gz".to_string(),
    piper_model_url:    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx".to_string(),
    piper_config_url:   "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json".to_string(),
    piper_install_note: note,
    total_mb_approx:    200,
  };

  #[cfg(target_os = "linux")]
  return DownloadInfo {
    whisper_exe_url:    "https://github.com/ggerganov/whisper.cpp/releases/latest".to_string(),
    whisper_model_url:  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin".to_string(),
    piper_zip_url:      "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz".to_string(),
    piper_model_url:    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx".to_string(),
    piper_config_url:   "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json".to_string(),
    piper_install_note: note,
    total_mb_approx:    200,
  };

  #[allow(unreachable_code)]
  DownloadInfo {
    whisper_exe_url: String::new(), whisper_model_url: String::new(),
    piper_zip_url: String::new(), piper_model_url: String::new(),
    piper_config_url: String::new(), piper_install_note: "Unsupported.".to_string(),
    total_mb_approx: 0,
  }
}

// ── Port check ────────────────────────────────────────────────────────────────

fn port_listening(port: u16) -> bool {
  use std::net::TcpStream;
  use std::time::Duration;
  TcpStream::connect_timeout(
    &format!("127.0.0.1:{}", port).parse().unwrap_or_else(|_| "0.0.0.0:0".parse().unwrap()),
    Duration::from_millis(200),
  ).is_ok()
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn voice_status(app: AppHandle) -> VoiceServerStatus {
  let dir = voice_data_dir(&app);
  VoiceServerStatus {
    whisper: ServerInfo {
      running:      port_listening(9900),
      port:         9900,
      exe_exists:   whisper_exe(&dir).exists(),
      model_exists: whisper_model(&dir).exists(),
      exe_path:     whisper_exe(&dir).to_string_lossy().to_string(),
      model_path:   whisper_model(&dir).to_string_lossy().to_string(),
    },
    piper: PiperStatus {
      exe_exists:   piper_exe(&dir).exists(),
      model_exists: piper_model(&dir).exists(),
      exe_path:     piper_exe(&dir).to_string_lossy().to_string(),
      model_path:   piper_model(&dir).to_string_lossy().to_string(),
      note: "Piper is called directly per TTS request — no HTTP server needed.".to_string(),
    },
    data_dir: dir.to_string_lossy().to_string(),
  }
}

#[tauri::command]
pub fn voice_download_info() -> DownloadInfo { download_info_inner() }

#[tauri::command]
pub async fn voice_start_servers(app: AppHandle) -> Result<String, String> {
  let dir = voice_data_dir(&app);
  let bin = whisper_exe(&dir);
  let mdl = whisper_model(&dir);
  let run_dir = whisper_run_dir(&dir);

  if !bin.exists() {
    return Err(format!(
      "whisper-server.exe not found at {}. Extract the whisper zip into voice/whisper/.",
      bin.display()
    ));
  }
  if !mdl.exists() {
    return Err(format!(
      "Model not found at {}. Download ggml-base.en.bin into voice/whisper/models/.",
      mdl.display()
    ));
  }

  #[cfg(unix)]
  { use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)); }

  let mut proc = WHISPER_PROC.lock().map_err(|e| e.to_string())?;
  if !port_listening(9900) {
    let child = Command::new(&bin)
      .args(["--host", "127.0.0.1", "--port", "9900",
             "--model", mdl.to_str().unwrap_or(""),
             "--language", "auto", "--convert"])
      .stdout(Stdio::null()).stderr(Stdio::null())
      // Run from voice/whisper/ so it finds its DLLs
      .current_dir(&run_dir)
      .spawn()
      .map_err(|e| format!("Failed to start whisper-server: {}", e))?;
    proc.child = Some(child);
  }

  std::thread::sleep(std::time::Duration::from_millis(1500));

  let whisper_ok = port_listening(9900);
  let piper_ok   = piper_exe(&dir).exists() && piper_model(&dir).exists();

  Ok(format!(
    "whisper-server: {} | piper: {}",
    if whisper_ok { "running on :9900 ✓" } else { "starting… wait a few seconds then check again" },
    if piper_ok   { "ready (direct mode) ✓" } else { "model missing — put .onnx + .json in voice/voices/" },
  ))
}

#[tauri::command]
pub fn voice_stop_servers() -> Result<String, String> {
  let mut proc = WHISPER_PROC.lock().map_err(|e| e.to_string())?;
  if let Some(mut c) = proc.child.take() { let _ = c.kill(); }
  Ok("whisper-server stopped.".to_string())
}

/// Synthesise speech: text → WAV bytes via piper CLI.
///
/// Spawns voice/piper/piper.exe with current_dir = voice/piper/ so Windows
/// can find espeak-ng.dll, piper_phonemize.dll, onnxruntime.dll.
/// Model is read from voice/voices/en_US-lessac-medium.onnx.
#[tauri::command]
pub async fn voice_tts_speak(app: AppHandle, text: String, speed: Option<f32>) -> Result<Vec<u8>, String> {
  let dir     = voice_data_dir(&app);
  let bin     = piper_exe(&dir);
  let mdl     = piper_model(&dir);
  let run_dir = piper_run_dir(&dir);

  if !bin.exists() {
    return Err(format!(
      "piper.exe not found at {}. Extract the full piper zip into voice/piper/.",
      bin.display()
    ));
  }
  if !mdl.exists() {
    return Err(format!(
      "Voice model not found at {}. Download en_US-lessac-medium.onnx into voice/voices/.",
      mdl.display()
    ));
  }

  let text = text.trim().to_string();
  if text.is_empty() { return Err("TTS text is empty.".to_string()); }

  // Write WAV to a temp file inside run_dir (DLLs live there, avoids path issues)
  let ts = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default().as_millis();
  let tmp_wav = run_dir.join(format!("tts_{}.wav", ts));

  // length_scale = 1/speed: speed=2.0 → ls=0.50 (twice as fast), speed=0.5 → ls=2.0 (slower)
  let length_scale = format!("{:.2}", 1.0_f32 / speed.unwrap_or(1.0).max(0.1));

  let mut child = Command::new(&bin)
    .args([
      "--model",            mdl.to_str().unwrap_or(""),
      "--output_file",      tmp_wav.to_str().unwrap_or(""),
      "--sentence_silence", "0.1",
      "--length_scale",     &length_scale,
      "--quiet",
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    // CRITICAL: run from voice/piper/ so Windows finds espeak-ng.dll etc.
    .current_dir(&run_dir)
    .spawn()
    .map_err(|e| format!(
      "Failed to spawn piper: {}. Make sure voice/piper/ has piper.exe + all DLLs + espeak-ng-data/.",
      e
    ))?;

  if let Some(mut stdin) = child.stdin.take() {
    let _ = writeln!(stdin, "{}", text);
  }

  let status = child.wait().map_err(|e| format!("piper wait failed: {}", e))?;

  if !status.success() {
    let _ = std::fs::remove_file(&tmp_wav);
    return Err(format!(
      "piper exited {:?}. Check voice/piper/ has all DLLs and espeak-ng-data/.",
      status.code()
    ));
  }

  if !tmp_wav.exists() {
    return Err("piper ran but wrote no WAV. Check en_US-lessac-medium.onnx.json is in voice/voices/.".to_string());
  }

  let bytes = std::fs::read(&tmp_wav).map_err(|e| format!("Read WAV failed: {}", e))?;
  let _ = std::fs::remove_file(&tmp_wav);

  if bytes.len() < 44 { return Err("piper produced an empty WAV.".to_string()); }
  Ok(bytes)
}