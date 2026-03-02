#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;
mod conversation;

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
            conversation::conversation_create,
            conversation::conversation_list,
            conversation::conversation_delete,
            conversation::message_send,
            conversation::message_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
