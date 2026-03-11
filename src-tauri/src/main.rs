#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;
mod conversation;
mod ollama_proxy;
mod mcp;
mod workspace;
mod voice;
mod db; // ← NEW: SQLite database commands

use storage::StorageManager;
use db::DbState;
use tauri::Manager;

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let handle = app.handle();
      let storage = StorageManager::new(&handle)?;
      app.manage(storage);

      // Initialize database
      let db_state = DbState::new();
      let db_path = app
        .path_resolver()
        .app_data_dir()
        .ok_or("Failed to get app data dir")?
        .join("nikolai.db");
      db_state.init(&db_path)?;
      app.manage(db_state);

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![

        // -------------------------
        // DATABASE (NEW)
        // -------------------------
        db::db_execute,
        db::db_select,

        // -------------------------
        // conversation
        // -------------------------
        conversation::conversation_create,
        conversation::conversation_list,
        conversation::conversation_delete,
        conversation::message_send,
        conversation::message_list,

        // -------------------------
        // ollama proxy (models + chat)
        // -------------------------
        ollama_proxy::ollama_tags,
        ollama_proxy::ollama_chat_once,
        ollama_proxy::ollama_chat_stream,
        ollama_proxy::ollama_chat_abort,

        // -------------------------
        // MCP (hub connect + tools)
        // -------------------------
        mcp::mcp_connect,
        mcp::mcp_disconnect,
        mcp::mcp_list_tools,
        mcp::mcp_call_tool,
        mcp::mcp_prepare_hub_config,

        // -------------------------
        // Voice (TTS + whisper server)
        // -------------------------
        voice::voice_status,
        voice::voice_download_info,
        voice::voice_start_servers,
        voice::voice_stop_servers,
        voice::voice_tts_speak,

        // -------------------------
        // Workspace
        // -------------------------
        workspace::ws_set_root,
        workspace::ws_get_root,
        workspace::ws_list_dir,
        workspace::ws_read_text,
        workspace::ws_write_text,
        workspace::ws_mkdir,
        workspace::ws_batch_apply,
        workspace::ws_batch_rollback,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}