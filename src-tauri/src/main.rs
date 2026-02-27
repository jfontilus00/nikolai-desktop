#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod mcp;
mod secrets;
mod workspace;
mod ollama_proxy;

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      // MCP
      mcp::mcp_status,
      mcp::mcp_info,
      mcp::mcp_connect,
      mcp::mcp_disconnect,
      mcp::mcp_list_tools,
      mcp::mcp_call_tool,

      // Secrets (OS keychain)
      secrets::secret_set,
      secrets::secret_get,
      secrets::secret_delete,

      // Workspace (local, safe)
      workspace::ws_set_root,
      workspace::ws_get_root,
      workspace::ws_list_dir,
      workspace::ws_read_text,
      workspace::ws_write_text,
      workspace::ws_mkdir,

      // Workspace (batch apply + rollback)
      workspace::ws_batch_apply,
      workspace::ws_batch_rollback,

      // Ollama proxy (fix MSI/EXE fetch restrictions)
      ollama_proxy::ollama_tags,
      ollama_proxy::ollama_chat_once,
      ollama_proxy::ollama_chat_stream,
      ollama_proxy::ollama_chat_abort
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
