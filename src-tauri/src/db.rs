// ── Nikolai Desktop — Database Module ────────────────────────────────────────
//
// Provides SQLite database operations for conversations and messages.
// Uses rusqlite for direct database access.
//

use rusqlite::{Connection, params};
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

// ── Database state manager ───────────────────────────────────────────────────
// Holds a shared connection accessible from Tauri commands.

pub struct DbState(pub Mutex<Option<Connection>>);

impl DbState {
    pub fn new() -> Self {
        DbState(Mutex::new(None))
    }

    pub fn init(&self, db_path: &Path) -> Result<(), String> {
        let conn = init_db(db_path)?;
        let mut guard = self.0.lock().map_err(|e| format!("Mutex poison: {}", e))?;
        *guard = Some(conn);
        Ok(())
    }

    pub fn with_connection<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let guard = self.0.lock().map_err(|e| format!("Mutex poison: {}", e))?;
        let conn = guard.as_ref().ok_or("Database not initialized")?;
        f(conn)
    }
}

// ── Database initialization ──────────────────────────────────────────────────

pub fn init_db(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path)
        .map_err(|e| format!("Failed to open database: {}", e))?;

    // Create conversations table with summary column
    conn.execute(
        "CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT,
            model TEXT,
            summary TEXT,
            created_at INTEGER,
            updated_at INTEGER
        )",
        [],
    )
    .map_err(|e| format!("Failed to create conversations table: {}", e))?;

    // Create messages table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            role TEXT,
            content TEXT,
            timestamp INTEGER,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id)
        )",
        [],
    )
    .map_err(|e| format!("Failed to create messages table: {}", e))?;

    // Create index for faster message lookups
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp)",
        [],
    )
    .map_err(|e| format!("Failed to create index: {}", e))?;

    Ok(conn)
}

// ── Conversation operations ──────────────────────────────────────────────────

pub fn create_conversation(
    conn: &Connection,
    id: &str,
    title: &str,
    model: &str,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))?
        .as_millis() as i64;

    conn.execute(
        "INSERT INTO conversations (id, title, model, summary, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)",
        params![id, title, model, now, now],
    )
    .map_err(|e| format!("Failed to create conversation: {}", e))?;

    Ok(())
}

pub fn update_conversation_title(conn: &Connection, id: &str, title: &str) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))?
        .as_millis() as i64;

    conn.execute(
        "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
        params![title, now, id],
    )
    .map_err(|e| format!("Failed to update conversation title: {}", e))?;

    Ok(())
}

pub fn update_conversation_summary(conn: &Connection, id: &str, summary: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE conversations SET summary = ? WHERE id = ?",
        params![summary, id],
    )
    .map_err(|e| format!("Failed to update conversation summary: {}", e))?;

    Ok(())
}

pub fn list_conversations(conn: &Connection) -> Result<Vec<(String, String, String, i64, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, model, created_at, updated_at
             FROM conversations
             ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("Failed to prepare statement: {}", e))?;

    let conversations = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("Failed to query conversations: {}", e))?;

    let mut result = Vec::new();
    for conv in conversations {
        result.push(conv.map_err(|e| format!("Row error: {}", e))?);
    }

    Ok(result)
}

pub fn delete_conversation(conn: &Connection, id: &str) -> Result<(), String> {
    // Delete messages first (foreign key constraint)
    conn.execute("DELETE FROM messages WHERE conversation_id = ?", params![id])
        .map_err(|e| format!("Failed to delete messages: {}", e))?;

    conn.execute("DELETE FROM conversations WHERE id = ?", params![id])
        .map_err(|e| format!("Failed to delete conversation: {}", e))?;

    Ok(())
}

// ── Message operations ───────────────────────────────────────────────────────

pub fn save_message(
    conn: &Connection,
    id: &str,
    conv_id: &str,
    role: &str,
    content: &str,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))?
        .as_millis() as i64;

    conn.execute(
        "INSERT INTO messages (id, conversation_id, role, content, timestamp)
         VALUES (?, ?, ?, ?, ?)",
        params![id, conv_id, role, content, now],
    )
    .map_err(|e| format!("Failed to save message: {}", e))?;

    // Update conversation's updated_at timestamp
    conn.execute(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        params![now, conv_id],
    )
    .map_err(|e| format!("Failed to update conversation timestamp: {}", e))?;

    Ok(())
}

pub fn load_messages(conn: &Connection, conv_id: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT role, content FROM messages
             WHERE conversation_id = ?
             ORDER BY timestamp",
        )
        .map_err(|e| format!("Failed to prepare statement: {}", e))?;

    let messages = stmt
        .query_map(params![conv_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query messages: {}", e))?;

    let mut result = Vec::new();
    for msg in messages {
        result.push(msg.map_err(|e| format!("Row error: {}", e))?);
    }

    Ok(result)
}

pub fn delete_message(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM messages WHERE id = ?", params![id])
        .map_err(|e| format!("Failed to delete message: {}", e))?;

    Ok(())
}

// ── Message compression ──────────────────────────────────────────────────────
// Automatically compresses old messages when conversation exceeds threshold.
// Builds a simple text summary from early messages and deletes them.

pub fn compress_messages_if_needed(conn: &Connection, conv_id: &str) -> Result<(), String> {
    // Count messages for this conversation
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?",
            params![conv_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count messages: {}", e))?;

    // If 30 or fewer messages, no compression needed
    if count <= 30 {
        return Ok(());
    }

    // Fetch first 20 messages (oldest) ordered by timestamp
    let mut stmt = conn
        .prepare(
            "SELECT role, content FROM messages
             WHERE conversation_id = ?
             ORDER BY timestamp
             LIMIT 20",
        )
        .map_err(|e| format!("Failed to prepare compression query: {}", e))?;

    let messages = stmt
        .query_map(params![conv_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query messages for compression: {}", e))?;

    // Build summary text by concatenating role + content
    let mut summary_parts = Vec::new();
    for msg in messages {
        let (role, content) = msg.map_err(|e| format!("Row error: {}", e))?;
        summary_parts.push(format!("[{}]: {}", role, content));
    }

    let summary_text = summary_parts.join("\n");

    // Update conversation.summary with the compressed text
    update_conversation_summary(conn, conv_id, &summary_text)?;

    // Delete the first 20 messages
    conn.execute(
        "DELETE FROM messages
         WHERE id IN (
             SELECT id FROM messages
             WHERE conversation_id = ?
             ORDER BY timestamp
             LIMIT 20
         )",
        params![conv_id],
    )
    .map_err(|e| format!("Failed to delete compressed messages: {}", e))?;

    Ok(())
}

// ── Utility functions ────────────────────────────────────────────────────────

pub fn get_conversation_count(conn: &Connection) -> Result<i64, String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM conversations", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count conversations: {}", e))?;

    Ok(count)
}

pub fn clear_all_data(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM messages", [])
        .map_err(|e| format!("Failed to clear messages: {}", e))?;

    conn.execute("DELETE FROM conversations", [])
        .map_err(|e| format!("Failed to clear conversations: {}", e))?;

    Ok(())
}

// ── Tauri commands ───────────────────────────────────────────────────────────
// Exposes database operations to the frontend via invoke().
// Uses JSON for parameter passing to avoid rusqlite Value serialization issues.

#[tauri::command]
pub fn db_execute(
    db_state: State<'_, DbState>,
    query: String,
    values: Vec<serde_json::Value>,
) -> Result<(), String> {
    db_state.with_connection(|conn| {
        let params = params_from_json(&values);
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
        conn.execute(&query, &param_refs[..])
            .map_err(|e| format!("Execute failed: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn db_select(
    db_state: State<'_, DbState>,
    query: String,
    values: Vec<serde_json::Value>,
) -> Result<Vec<Vec<serde_json::Value>>, String> {
    db_state.with_connection(|conn| {
        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Prepare failed: {}", e))?;

        let params = params_from_json(&values);
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt
            .query_map(&param_refs[..], |row| {
                let mut result = Vec::new();
                for i in 0.. {
                    let col: rusqlite::types::Value = match row.get(i) {
                        Ok(v) => v,
                        Err(_) => break,
                    };
                    result.push(value_to_json(col));
                }
                Ok::<Vec<serde_json::Value>, rusqlite::Error>(result)
            })
            .map_err(|e| format!("Query failed: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Row error: {}", e))?);
        }

        Ok(result)
    })
}

// Helper: convert Vec<serde_json::Value> to rusqlite params slice
fn params_from_json(values: &[serde_json::Value]) -> Vec<rusqlite::types::ToSqlOutput<'static>> {
    values
        .iter()
        .map(|v| json_to_rusqlite(v))
        .collect()
}

// Helper: convert serde_json::Value to rusqlite ToSqlOutput
fn json_to_rusqlite(value: &serde_json::Value) -> rusqlite::types::ToSqlOutput<'static> {
    match value {
        serde_json::Value::Null => rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Null),
        serde_json::Value::Bool(b) => rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Integer(*b as i64)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Integer(i))
            } else if let Some(f) = n.as_f64() {
                rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Real(f))
            } else {
                rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Integer(0))
            }
        }
        serde_json::Value::String(s) => rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Text(s.clone())),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Text(value.to_string()))
        }
    }
}

// Helper: convert rusqlite Value to serde_json::Value
fn value_to_json(value: rusqlite::types::Value) -> serde_json::Value {
    match value {
        rusqlite::types::Value::Null => serde_json::Value::Null,
        rusqlite::types::Value::Integer(i) => serde_json::json!(i),
        rusqlite::types::Value::Real(f) => serde_json::json!(f),
        rusqlite::types::Value::Text(s) => serde_json::json!(s),
        rusqlite::types::Value::Blob(_) => serde_json::Value::Null, // Blobs not supported in JSON
    }
}
