use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

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

#[derive(Default)]
struct Store {
  conversations: Vec<Conversation>,
  messages: HashMap<String, Vec<Message>>,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn store() -> &'static Mutex<Store> {
  STORE.get_or_init(|| Mutex::new(Store::default()))
}

fn now_ts() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs() as i64
}

fn new_id(prefix: &str) -> String {
  let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  format!("{prefix}_{n}")
}

#[tauri::command]
pub fn conversation_create(title: Option<String>) -> Result<Conversation, String> {
  let mut s = store().lock().map_err(|_| "store lock poisoned".to_string())?;
  let conv = Conversation {
    id: new_id("c"),
    title: title.unwrap_or_else(|| "New conversation".to_string()),
    created_at: now_ts(),
  };
  s.conversations.push(conv.clone());
  Ok(conv)
}

#[tauri::command]
pub fn conversation_list() -> Result<Vec<Conversation>, String> {
  let s = store().lock().map_err(|_| "store lock poisoned".to_string())?;
  Ok(s.conversations.clone())
}

#[tauri::command]
pub fn conversation_delete(conversation_id: String) -> Result<bool, String> {
  let mut s = store().lock().map_err(|_| "store lock poisoned".to_string())?;
  let before = s.conversations.len();
  s.conversations.retain(|c| c.id != conversation_id);
  s.messages.remove(&conversation_id);
  Ok(s.conversations.len() != before)
}

#[tauri::command]
pub fn message_send(
  conversation_id: String,
  role: String,
  content: String,
) -> Result<Message, String> {
  let mut s = store().lock().map_err(|_| "store lock poisoned".to_string())?;

  let exists = s.conversations.iter().any(|c| c.id == conversation_id);
  if !exists {
    return Err("conversation not found".to_string());
  }

  let msg = Message {
    id: new_id("m"),
    conversation_id: conversation_id.clone(),
    role,
    content,
    created_at: now_ts(),
  };

  s.messages.entry(conversation_id).or_default().push(msg.clone());
  Ok(msg)
}

#[tauri::command]
pub fn message_list(conversation_id: String) -> Result<Vec<Message>, String> {
  let s = store().lock().map_err(|_| "store lock poisoned".to_string())?;
  Ok(s.messages.get(&conversation_id).cloned().unwrap_or_default())
}