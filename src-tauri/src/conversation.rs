use serde::Serialize;
use tauri::State;
use crate::db::DbState;

#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
  pub id: String,
  pub title: String,
  pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
  pub id: String,
  pub conversation_id: String,
  pub role: String,
  pub content: String,
  pub created_at: i64,
}

fn new_id(prefix: &str) -> String {
  use std::sync::atomic::{AtomicU64, Ordering};
  static NEXT_ID: AtomicU64 = AtomicU64::new(1);
  let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  format!("{prefix}_{n}")
}

#[tauri::command]
pub fn conversation_create(
  db_state: State<'_, DbState>,
  title: Option<String>,
) -> Result<Conversation, String> {
  let id = new_id("c");
  let title = title.unwrap_or_else(|| "New conversation".to_string());
  let model = "default".to_string();
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_err(|e| format!("Time error: {}", e))?
    .as_millis() as i64;

  db_state.with_connection(|conn| {
    crate::db::create_conversation(conn, &id, &title, &model)?;
    Ok(())
  })?;

  Ok(Conversation {
    id,
    title,
    created_at: now,
  })
}

#[tauri::command]
pub fn conversation_list(
  db_state: State<'_, DbState>,
) -> Result<Vec<Conversation>, String> {
  db_state.with_connection(|conn| {
    let rows = crate::db::list_conversations(conn)?;
    let conversations = rows
      .into_iter()
      .map(|(id, title, _model, created_at, _updated_at)| Conversation {
        id,
        title,
        created_at,
      })
      .collect();
    Ok(conversations)
  })
}

#[tauri::command]
pub fn conversation_delete(
  db_state: State<'_, DbState>,
  conversation_id: String,
) -> Result<bool, String> {
  db_state.with_connection(|conn| {
    crate::db::delete_conversation(conn, &conversation_id)?;
    Ok(true)
  })
}

#[tauri::command]
pub fn message_send(
  db_state: State<'_, DbState>,
  conversation_id: String,
  role: String,
  content: String,
) -> Result<Message, String> {
  let id = new_id("m");
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_err(|e| format!("Time error: {}", e))?
    .as_millis() as i64;

  db_state.with_connection(|conn| {
    crate::db::save_message(conn, &id, &conversation_id, &role, &content)?;
    crate::db::compress_messages_if_needed(conn, &conversation_id)?;
    Ok(())
  })?;

  Ok(Message {
    id,
    conversation_id,
    role,
    content,
    created_at: now,
  })
}

#[tauri::command]
pub fn message_list(
  db_state: State<'_, DbState>,
  conversation_id: String,
) -> Result<Vec<Message>, String> {
  db_state.with_connection(|conn| {
    let rows = crate::db::load_messages(conn, &conversation_id)?;
    let messages = rows
      .into_iter()
      .map(|(id, role, content, timestamp)| Message {
        id,
        conversation_id: conversation_id.clone(),
        role,
        content,
        created_at: timestamp,
      })
      .collect();
    Ok(messages)
  })
}