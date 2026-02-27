// src-tauri/src/mcp_client.rs
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, process::Stdio, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::{
  io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
  process::{ChildStdin, Command},
  sync::{oneshot, Mutex},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpStatus {
  pub connected: bool,
  pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
  pub name: String,
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default)]
  pub input_schema: Option<Value>,
}

#[derive(Default)]
struct Meta {
  connected: bool,
  pid: Option<u32>,
  next_id: u64,
  pending: HashMap<u64, oneshot::Sender<Value>>,
  tools: Vec<McpTool>,
  logs: Vec<String>,
}

#[derive(Clone, Default)]
pub struct McpHubState {
  meta: std::sync::Arc<Mutex<Meta>>,
  stdin: std::sync::Arc<Mutex<Option<ChildStdin>>>,
}

async fn push_log(app: &AppHandle, hub: &McpHubState, line: String) {
  {
    let mut meta = hub.meta.lock().await;
    meta.logs.push(line.clone());
    // keep last 400 lines
    if meta.logs.len() > 400 {
      let drain = meta.logs.len() - 400;
      meta.logs.drain(0..drain);
    }
  }
  let _ = app.emit_all("mcp:log", line);
}

async fn set_connected(app: &AppHandle, hub: &McpHubState, connected: bool, pid: Option<u32>) {
  {
    let mut meta = hub.meta.lock().await;
    meta.connected = connected;
    meta.pid = pid;
  }
  let _ = app.emit_all(
    "mcp:status",
    McpStatus {
      connected,
      pid,
    },
  );
}

async fn send_notification(hub: &McpHubState, method: &str, params: Value) -> Result<(), String> {
  let msg = json!({
    "jsonrpc": "2.0",
    "method": method,
    "params": params
  });
  let text = format!("{}\n", msg.to_string());

  let mut guard = hub.stdin.lock().await;
  let stdin = guard.as_mut().ok_or("MCP not connected (stdin missing)")?;
  stdin
    .write_all(text.as_bytes())
    .await
    .map_err(|e| format!("stdin write failed: {}", e))?;
  stdin.flush().await.map_err(|e| format!("stdin flush failed: {}", e))?;
  Ok(())
}

async fn send_request(hub: &McpHubState, method: &str, params: Value) -> Result<Value, String> {
  let (id, rx) = {
    let mut meta = hub.meta.lock().await;
    meta.next_id += 1;
    let id = meta.next_id;
    let (tx, rx) = oneshot::channel();
    meta.pending.insert(id, tx);
    (id, rx)
  };

  let msg = json!({
    "jsonrpc": "2.0",
    "id": id,
    "method": method,
    "params": params
  });
  let text = format!("{}\n", msg.to_string());

  {
    let mut guard = hub.stdin.lock().await;
    let stdin = guard.as_mut().ok_or("MCP not connected (stdin missing)")?;
    stdin
      .write_all(text.as_bytes())
      .await
      .map_err(|e| format!("stdin write failed: {}", e))?;
    stdin.flush().await.map_err(|e| format!("stdin flush failed: {}", e))?;
  }

  let resp = tokio::time::timeout(Duration::from_secs(20), rx)
    .await
    .map_err(|_| "MCP request timeout".to_string())?
    .map_err(|_| "MCP response channel closed".to_string())?;

  if let Some(err) = resp.get("error") {
    return Err(format!("MCP error: {}", err));
  }

  Ok(resp.get("result").cloned().unwrap_or(resp))
}

#[tauri::command]
pub async fn mcp_status(hub: State<'_, McpHubState>) -> Result<McpStatus, String> {
  let meta = hub.meta.lock().await;
  Ok(McpStatus {
    connected: meta.connected,
    pid: meta.pid,
  })
}

#[tauri::command]
pub async fn mcp_log_tail(hub: State<'_, McpHubState>, n: Option<usize>) -> Result<Vec<String>, String> {
  let n = n.unwrap_or(200);
  let meta = hub.meta.lock().await;
  let len = meta.logs.len();
  let start = len.saturating_sub(n);
  Ok(meta.logs[start..].to_vec())
}

#[tauri::command]
pub async fn mcp_connect(
  app: AppHandle,
  hub: State<'_, McpHubState>,
  cmd: String,
  args: Vec<String>,
  cwd: Option<String>,
) -> Result<McpStatus, String> {
  // If already connected, just return status
  {
    let meta = hub.meta.lock().await;
    if meta.connected {
      return Ok(McpStatus {
        connected: true,
        pid: meta.pid,
      });
    }
  }

  let mut c = Command::new(&cmd);
  c.args(&args)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  if let Some(dir) = &cwd {
    c.current_dir(dir);
  }

  let mut child = c.spawn().map_err(|e| format!("spawn failed: {}", e))?;
  let pid = child.id();

  let stdin = child.stdin.take().ok_or("child stdin missing")?;
  let stdout = child.stdout.take().ok_or("child stdout missing")?;
  let stderr = child.stderr.take().ok_or("child stderr missing")?;

  {
    let mut guard = hub.stdin.lock().await;
    *guard = Some(stdin);
  }

  // Mark connected immediately (no blocking)
  set_connected(&app, &hub, true, pid).await;
  push_log(&app, &hub, format!("[mcp] spawned pid={:?}", pid)).await;

  // STDOUT reader (JSON-RPC responses + any stdout logs)
  let hub_for_out = hub.inner().clone();
  let app_for_out = app.clone();
  tokio::spawn(async move {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      // Try JSON parse (responses). If not JSON => log it.
      match serde_json::from_str::<Value>(&line) {
        Ok(v) => {
          if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
            let mut meta = hub_for_out.meta.lock().await;
            if let Some(tx) = meta.pending.remove(&id) {
              let _ = tx.send(v);
            }
          } else {
            // notification / event
            let _ = app_for_out.emit_all("mcp:event", v);
          }
        }
        Err(_) => {
          push_log(&app_for_out, &hub_for_out, format!("[stdout] {}", line)).await;
        }
      }
    }

    // process ended / pipe closed
    set_connected(&app_for_out, &hub_for_out, false, None).await;
    push_log(&app_for_out, &hub_for_out, "[mcp] stdout closed".to_string()).await;
  });

  // STDERR reader (logs)
  let hub_for_err = hub.inner().clone();
  let app_for_err = app.clone();
  tokio::spawn(async move {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      push_log(&app_for_err, &hub_for_err, format!("[stderr] {}", line)).await;
    }
  });

  // Initialize handshake (best effort; won't block UI)
  let hub_for_init = hub.inner().clone();
  let app_for_init = app.clone();
  tokio::spawn(async move {
    // Some servers require initialize + initialized notification
    let init_params = json!({
      "protocolVersion": "2024-11-05",
      "clientInfo": { "name": "nikolai-desktop", "version": "0.1.0" },
      "capabilities": { "tools": {} }
    });

    match send_request(&hub_for_init, "initialize", init_params).await {
      Ok(_) => {
        let _ = send_notification(&hub_for_init, "notifications/initialized", json!({})).await;
        push_log(&app_for_init, &hub_for_init, "[mcp] initialize ok".to_string()).await;
      }
      Err(e) => {
        push_log(&app_for_init, &hub_for_init, format!("[mcp] initialize failed: {}", e)).await;
      }
    }
  });

  Ok(McpStatus {
    connected: true,
    pid,
  })
}

#[tauri::command]
pub async fn mcp_list_tools(app: AppHandle, hub: State<'_, McpHubState>) -> Result<Vec<McpTool>, String> {
  if !hub.meta.lock().await.connected {
    return Err("MCP not connected".to_string());
  }

  let result = send_request(hub.inner(), "tools/list", json!({})).await?;
  let tools_val = result
    .get("tools")
    .cloned()
    .unwrap_or(Value::Array(vec![]));

  let mut tools: Vec<McpTool> = vec![];
  if let Value::Array(arr) = tools_val {
    for t in arr {
      let name = t.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
      if name.is_empty() {
        continue;
      }
      let description = t.get("description").and_then(|x| x.as_str()).map(|s| s.to_string());
      let input_schema = t.get("inputSchema").cloned().or_else(|| t.get("input_schema").cloned());
      tools.push(McpTool {
        name,
        description,
        input_schema,
      });
    }
  }

  {
    let mut meta = hub.meta.lock().await;
    meta.tools = tools.clone();
  }

  let _ = app.emit_all("mcp:tools", tools.clone());
  Ok(tools)
}

#[tauri::command]
pub async fn mcp_call_tool(hub: State<'_, McpHubState>, name: String, args: Value) -> Result<Value, String> {
  if !hub.meta.lock().await.connected {
    return Err("MCP not connected".to_string());
  }

  let params = json!({
    "name": name,
    "arguments": args
  });

  let result = send_request(hub.inner(), "tools/call", params).await?;
  Ok(result)
}
