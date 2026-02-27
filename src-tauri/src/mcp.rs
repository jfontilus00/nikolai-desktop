use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
  collections::HashMap,
  process::Stdio,
  sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
  },
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
  io::{AsyncReadExt, AsyncWriteExt},
  process::{Child, ChildStdin, ChildStdout, Command},
  sync::{oneshot, Mutex},
  time::timeout,
};
use tauri::{AppHandle, Manager};

// ── Timeout reduced from 60s to 25s ──────────────────────────────────────────
// Frontend tool timeout is 20s (TOOL_TIMEOUT_MS in App.tsx). Rust MCP layer
// must sit slightly above that so the frontend error fires first — the user
// sees a clean "Tool timeout: <name>" message instead of a confusing race.
// 25s gives 5s of buffer. Old value of 60s meant a hung tool could block an
// entire 10-step agent run for up to 10 minutes.
const MCP_TIMEOUT_SECS: u64 = 25;
const MAX_BUFFER_SIZE: usize = 10 * 1024 * 1024; // 10MB
const INITIALIZATION_TIMEOUT_SECS: u64 = 30;
const KILL_WAIT_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, Deserialize)]
pub struct McpConnectConfig {
  pub command: String,
  pub args: Vec<String>,
  pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
  pub connected: bool,
  pub command: Option<String>,
  pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpTool {
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(rename = "inputSchema", skip_serializing_if = "Option::is_none")]
  pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpInfo {
  pub timeout_secs: u64,
  pub protocol_version: String,
}

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, Value>>>;

struct McpClient {
  child: Mutex<Child>,
  stdin: Mutex<ChildStdin>,
  pending: Mutex<PendingMap>,
  next_id: AtomicU64,
  command: String,
  cwd: Option<String>,
  _reader_abort: tokio::sync::Mutex<Option<tokio::task::AbortHandle>>,
}

#[derive(Clone)]
enum McpState {
  Disconnected,
  Connecting {
    started_at: u64,
    cfg_summary: String,
  },
  Connected {
    client: Arc<McpClient>,
    connected_at: u64,
  },
  Error {
    message: String,
    at: u64,
  },
}

static MCP: OnceCell<Mutex<McpState>> = OnceCell::new();

fn ensure_state() -> &'static Mutex<McpState> {
  MCP.get_or_init(|| Mutex::new(McpState::Disconnected))
}

fn now_millis() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64
}

fn emit_state_change(app: &AppHandle, state: &str, message: Option<String>) {
  let payload = json!({
    "state": state,
    "message": message,
    "ts": now_millis()
  });
  let _ = app.emit_all("mcp://state", payload);
}

async fn fail_all_pending(client: &McpClient, error: &str) {
  let mut pending = client.pending.lock().await;
  for (_, tx) in pending.drain() {
    let _ = tx.send(Err(json!(error)));
  }
}

async fn handle_message(raw: &str, client: &Arc<McpClient>, _app: &AppHandle) {
  let v: Value = match serde_json::from_str(raw) {
    Ok(v) => v,
    Err(e) => {
      let preview = if raw.len() > 200 { &raw[..200] } else { raw };
      eprintln!("[mcp] JSON parse error: {}, input: {}", e, preview);
      return;
    }
  };

  let id = match v.get("id").and_then(|x| x.as_u64()) {
    Some(id) => id,
    None => return,
  };

  let result = if v.get("error").is_some() {
    Err(v.get("error").cloned().unwrap_or(Value::Null))
  } else {
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
  };

  let mut pending = client.pending.lock().await;
  if let Some(tx) = pending.remove(&id) {
    let _ = tx.send(result);
  }
}

// ── PRIORITY 3 FIX ────────────────────────────────────────────────────────────
//
// BEFORE: reader_loop received `read_state: Arc<Mutex<McpState>>` — a LOCAL Arc
// created only for this reader, separate from the global MCP static. When the
// process exited (EOF/crash), the loop updated read_state but the UI was watching
// the global MCP. So the UI stayed on "connected" while all new tool calls
// silently hung or failed.
//
// AFTER: reader_loop now receives `global_state: &'static Mutex<McpState>` — the
// real global MCP state. On EOF or read error it transitions the global state to
// Disconnected and emits the mcp://state event so the JS/UI updates immediately.
//
async fn reader_loop(
  mut out: ChildStdout,
  client: Arc<McpClient>,
  app: AppHandle,
  global_state: &'static Mutex<McpState>, // <- was Arc<Mutex<McpState>> (local copy)
) {
  let mut buf: Vec<u8> = Vec::with_capacity(8192);
  let mut tmp = [0u8; 4096];

  loop {
    let n = match out.read(&mut tmp).await {
      Ok(0) => break,  // EOF — process exited cleanly
      Ok(n) => n,
      Err(e) => {
        eprintln!("[mcp] read error: {}", e);
        break;
      }
    };

    buf.extend_from_slice(&tmp[..n]);

    if buf.len() > MAX_BUFFER_SIZE {
      eprintln!("[mcp] Buffer overflow: {} bytes exceeds limit of {}", buf.len(), MAX_BUFFER_SIZE);

      {
        let mut state = global_state.lock().await;
        if let McpState::Connected { ref client, .. } = *state {
          fail_all_pending(client, "Buffer overflow").await;
        }
        *state = McpState::Error {
          message: "Buffer overflow: MCP server sent too much data".to_string(),
          at: now_millis(),
        };
      }
      emit_state_change(&app, "error", Some("Buffer overflow: MCP server sent too much data".to_string()));
      return;
    }

    loop {
      let s = match std::str::from_utf8(&buf) {
        Ok(s) => s,
        Err(_) => break,
      };

      // LSP-style Content-Length framing
      if s.starts_with("Content-Length:") {
        if let Some(hdr_end) = s.find("\r\n\r\n") {
          let headers = &s[..hdr_end];
          let mut len: usize = 0;

          for line in headers.lines() {
            if let Some(v) = line.strip_prefix("Content-Length:") {
              len = v.trim().parse::<usize>().unwrap_or(0);
            }
          }

          let total_needed = hdr_end + 4 + len;
          if buf.len() < total_needed {
            break;
          }

          let json_bytes = buf[(hdr_end + 4)..(hdr_end + 4 + len)].to_vec();
          let json_str = String::from_utf8_lossy(&json_bytes).to_string();
          buf.drain(0..total_needed);

          handle_message(&json_str, &client, &app).await;
          continue;
        }
        break;
      }

      // Newline-delimited JSON
      if let Some(pos) = s.find('\n') {
        let line = s[..pos].trim().to_string();
        buf.drain(0..pos + 1);

        if !line.is_empty() {
          handle_message(&line, &client, &app).await;
        }
        continue;
      }

      break;
    }
  }

  // ── EOF/crash cleanup — update GLOBAL state ──────────────────────────────
  eprintln!("[mcp] Reader loop exiting (EOF/process exit)");

  let was_connected = {
    let mut state = global_state.lock().await;
    match &*state {
      McpState::Connected { ref client, .. } => {
        fail_all_pending(client, "MCP process exited unexpectedly").await;
        *state = McpState::Disconnected;
        true
      }
      McpState::Connecting { .. } => {
        *state = McpState::Error {
          message: "MCP process exited during initialization".to_string(),
          at: now_millis(),
        };
        false
      }
      _ => false,
    }
  }; // <- guard dropped before emit

  if was_connected {
    eprintln!("[mcp] Unexpected disconnect — emitting disconnected event");
    emit_state_change(&app, "disconnected", Some("MCP process exited unexpectedly".to_string()));
  } else {
    let is_init_error = {
      let state = global_state.lock().await;
      matches!(&*state, McpState::Error { .. })
    };
    if is_init_error {
      emit_state_change(&app, "error", Some("MCP process exited during initialization".to_string()));
    }
  }
}

async fn notify_with_client(client: Arc<McpClient>, method: &str, params: Value) -> Result<(), String> {
  let msg = json!({
    "jsonrpc": "2.0",
    "method": method,
    "params": params
  });
  let text = msg.to_string() + "\n";

  let mut stdin = client.stdin.lock().await;
  stdin
    .write_all(text.as_bytes())
    .await
    .map_err(|e| format!("stdin write failed: {}", e))?;
  stdin.flush().await.map_err(|e| format!("stdin flush failed: {}", e))?;
  Ok(())
}

async fn request_with_client(client: Arc<McpClient>, method: &str, params: Value) -> Result<Value, String> {
  let id = client.next_id.fetch_add(1, Ordering::SeqCst);

  let req = json!({
    "jsonrpc":"2.0",
    "id": id,
    "method": method,
    "params": params
  });

  let (tx, rx) = oneshot::channel::<Result<Value, Value>>();
  {
    let mut pending = client.pending.lock().await;
    pending.insert(id, tx);
  }

  {
    let mut stdin = client.stdin.lock().await;
    let line = req.to_string() + "\n";
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
  }

  match timeout(Duration::from_secs(MCP_TIMEOUT_SECS), rx).await {
    Ok(Ok(Ok(v))) => Ok(v),
    Ok(Ok(Err(e))) => Err(format!("MCP error: {}", e)),
    Ok(Err(_)) => Err("MCP response channel closed".to_string()),
    Err(_) => Err("MCP timeout".to_string()),
  }
}

async fn request(method: &str, params: Value) -> Result<Value, String> {
  let state = ensure_state();
  let client = {
    let guard = state.lock().await;
    match &*guard {
      McpState::Connected { client, .. } => client.clone(),
      _ => return Err("MCP not connected".to_string()),
    }
  }; // <- guard dropped here before any await
  request_with_client(client, method, params).await
}

#[tauri::command]
pub async fn mcp_status() -> McpStatus {
  let state = ensure_state();
  let guard = state.lock().await;

  match &*guard {
    McpState::Connected { client, .. } => McpStatus {
      connected: true,
      command: Some(client.command.clone()),
      cwd: client.cwd.clone(),
    },
    _ => McpStatus {
      connected: false,
      command: None,
      cwd: None,
    },
  }
}

#[tauri::command]
pub async fn mcp_info() -> McpInfo {
  McpInfo {
    timeout_secs: MCP_TIMEOUT_SECS,
    protocol_version: "2024-11-05".to_string(),
  }
}

#[tauri::command]
pub async fn mcp_connect(
  cfg: McpConnectConfig,
  app: AppHandle,
) -> Result<McpStatus, String> {
  let state = ensure_state();
  let cfg_summary = format!("{} {}", cfg.command, cfg.args.join(" "));

  {
    let mut guard = state.lock().await;
    match &*guard {
      McpState::Disconnected | McpState::Error { .. } => {
        *guard = McpState::Connecting {
          started_at: now_millis(),
          cfg_summary: cfg_summary.clone(),
        };
        emit_state_change(&app, "connecting", Some(cfg_summary.clone()));
      }
      McpState::Connecting { .. } | McpState::Connected { .. } => {
        return Ok(mcp_status().await);
      }
    }
  } // <- guard dropped here

  if cfg.command.trim().is_empty() {
    let mut guard = state.lock().await;
    *guard = McpState::Error {
      message: "Command is empty".to_string(),
      at: now_millis(),
    };
    emit_state_change(&app, "error", Some("Command is empty".to_string()));
    return Err("Command is empty".to_string());
  }

  let mut cmd = Command::new(&cfg.command);
  cmd.args(&cfg.args)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit());

  if let Some(cwd) = &cfg.cwd {
    if !cwd.trim().is_empty() {
      cmd.current_dir(cwd);
    }
  }

  let mut child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => {
      let mut guard = state.lock().await;
      *guard = McpState::Error {
        message: format!("spawn failed: {}", e),
        at: now_millis(),
      };
      emit_state_change(&app, "error", Some(format!("spawn failed: {}", e)));
      return Err(format!("spawn failed: {}", e));
    }
  };

  let stdin = child.stdin.take().ok_or("Failed to open stdin")?;
  let stdout = child.stdout.take().ok_or("Failed to open stdout")?;

  let client = Arc::new(McpClient {
    child: Mutex::new(child),
    stdin: Mutex::new(stdin),
    pending: Mutex::new(HashMap::new()),
    next_id: AtomicU64::new(1),
    command: cfg.command.clone(),
    cwd: cfg.cwd.clone(),
    _reader_abort: tokio::sync::Mutex::new(None),
  });

  let c_out = client.clone();
  let app_clone = app.clone();

  // PRIORITY 3 FIX: pass ensure_state() (the real global) to reader_loop
  let reader_handle = tokio::spawn(async move {
    reader_loop(stdout, c_out, app_clone, ensure_state()).await;
  });

  {
    let mut abort = client._reader_abort.lock().await;
    *abort = Some(reader_handle.abort_handle());
  }

  let init_result = timeout(
    Duration::from_secs(INITIALIZATION_TIMEOUT_SECS),
    request_with_client(
      client.clone(),
      "initialize",
      json!({
        "protocolVersion": "2024-11-05",
        "clientInfo": { "name":"Nikolai Desktop", "version":"0.1.0" },
        "capabilities": { "tools": {} }
      }),
    )
  ).await;

  match init_result {
    Ok(Ok(_)) => {
      let _ = notify_with_client(client.clone(), "notifications/initialized", json!({})).await;

      {
        let mut guard = state.lock().await;
        *guard = McpState::Connected {
          client: client.clone(),
          connected_at: now_millis(),
        };
      } // <- guard released here

      emit_state_change(&app, "connected", None);
      println!("[mcp] initialize success");

      Ok(mcp_status().await)
    }
    Ok(Err(e)) => {
      eprintln!("[mcp] initialization failed: {}", e);

      {
        let mut child = client.child.lock().await;
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(KILL_WAIT_TIMEOUT_SECS), child.wait()).await;
      }

      if let Some(abort) = client._reader_abort.lock().await.take() {
        abort.abort();
      }

      fail_all_pending(&client, "Initialization failed").await;

      {
        let mut guard = state.lock().await;
        *guard = McpState::Error {
          message: format!("Initialization failed: {}", e),
          at: now_millis(),
        };
      }
      emit_state_change(&app, "error", Some(format!("Initialization failed: {}", e)));

      Err(format!("Initialization failed: {}", e))
    }
    Err(_elapsed) => {
      eprintln!("[mcp] initialization timed out");

      {
        let mut child = client.child.lock().await;
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(KILL_WAIT_TIMEOUT_SECS), child.wait()).await;
      }

      if let Some(abort) = client._reader_abort.lock().await.take() {
        abort.abort();
      }

      fail_all_pending(&client, "Initialization timed out").await;

      {
        let mut guard = state.lock().await;
        *guard = McpState::Error {
          message: "Initialization timed out".to_string(),
          at: now_millis(),
        };
      }
      emit_state_change(&app, "error", Some("Initialization timed out".to_string()));

      Err("Initialization timed out".to_string())
    }
  }
}

#[tauri::command]
pub async fn mcp_disconnect(app: AppHandle) -> Result<McpStatus, String> {
  let state = ensure_state();

  let client_opt = {
    let mut guard = state.lock().await;
    let current = std::mem::replace(&mut *guard, McpState::Disconnected);
    match current {
      McpState::Connected { client, .. } => Some(client),
      _ => None,
    }
  }; // <- guard dropped here

  emit_state_change(&app, "disconnected", None);

  if let Some(client) = client_opt {
    if let Some(abort) = client._reader_abort.lock().await.take() {
      abort.abort();
    }

    fail_all_pending(&client, "Disconnected").await;

    let mut child = client.child.lock().await;
    let _ = child.start_kill();
    let _ = timeout(Duration::from_secs(KILL_WAIT_TIMEOUT_SECS), child.wait()).await;
  }

  Ok(mcp_status().await)
}

#[tauri::command]
pub async fn mcp_list_tools() -> Result<Vec<McpTool>, String> {
  let v = request("tools/list", json!({})).await?;
  let tools = v.get("tools").cloned().unwrap_or(Value::Array(vec![]));

  let mut out: Vec<McpTool> = vec![];
  if let Value::Array(arr) = tools {
    for t in arr {
      let name = t.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
      if name.is_empty() {
        continue;
      }
      let description = t.get("description").and_then(|x| x.as_str()).map(|s| s.to_string());
      let input_schema = t.get("inputSchema").cloned().or_else(|| t.get("input_schema").cloned());
      out.push(McpTool { name, description, input_schema });
    }
  }

  Ok(out)
}

#[tauri::command]
pub async fn mcp_call_tool(name: String, args: Value, app: AppHandle) -> Result<Value, String> {
  // ── Tool progress streaming ───────────────────────────────────────────────
  // Emit "start" immediately so the frontend can show a live indicator before
  // the tool response arrives. MCP tools/call is request-response (not a stream),
  // so the result still arrives all at once — but the user now sees instant
  // feedback showing which tool is executing rather than N seconds of silence.
  let _ = app.emit_all("mcp://tool-progress", json!({
    "phase": "start",
    "tool": name,
    "ts":   now_millis()
  }));

  let result = request(
    "tools/call",
    json!({
      "name":      name,
      "arguments": args
    }),
  )
  .await;

  // Emit "done" so the frontend can clear the live indicator
  let _ = app.emit_all("mcp://tool-progress", json!({
    "phase": "done",
    "tool": name,
    "ok":   result.is_ok(),
    "ts":   now_millis()
  }));

  result.map(|v| v)
}