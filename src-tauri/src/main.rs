#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;
mod conversation;
mod ollama_proxy;
mod mcp;
mod voice;

use storage::StorageManager;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle();
            let storage = StorageManager::new(&handle)?;
            app.manage(storage);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // conversation
            conversation::conversation_create,
            conversation::conversation_list,
            conversation::conversation_delete,
            conversation::message_send,
            conversation::message_list,

            // ollama proxy (models + chat)
            ollama_proxy::ollama_tags,
            ollama_proxy::ollama_chat_once,
            ollama_proxy::ollama_chat_stream,
            ollama_proxy::ollama_chat_abort,

            // MCP (hub connect + tools)
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,

            // Voice (TTS + whisper server)
            voice::voice_status,
            voice::voice_download_info,
            voice::voice_start_servers,
            voice::voice_stop_servers,
            voice::voice_tts_speak,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
