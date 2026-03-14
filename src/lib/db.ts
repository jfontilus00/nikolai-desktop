// ── SQLite Database Layer ────────────────────────────────────────────────────
//
// Provides persistent storage for conversations and messages using rusqlite.
// Replaces localStorage for chat data.
//
// Database file: nikolai.db (stored in app data directory)
//

import { invoke } from "@tauri-apps/api/tauri";

// ── Database operations via Tauri commands ───────────────────────────────────

async function dbExecute(query: string, values: any[] = []): Promise<void> {
  await invoke("db_execute", { query, values });
}

async function dbSelect(query: string, values: any[] = []): Promise<any[]> {
  return await invoke("db_select", { query, values });
}

// ── Conversation operations ──────────────────────────────────────────────────

export async function createConversation(
  id: string,
  title: string,
  model: string
): Promise<void> {
  const now = Date.now();

  await dbExecute(
    "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, model TEXT, created_at INTEGER, updated_at INTEGER)",
    []
  );

  await dbExecute(
    "INSERT OR REPLACE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, title, model, now, now]
  );
}

export async function updateConversationTitle(
  id: string,
  title: string
): Promise<void> {
  await dbExecute(
    "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
    [title, Date.now(), id]
  );
}

export async function listConversations(): Promise<Array<{
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
}>> {
  await dbExecute(
    "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, model TEXT, created_at INTEGER, updated_at INTEGER)",
    []
  );

  const rows = await dbSelect(
    "SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC",
    []
  );

  return rows as Array<{
    id: string;
    title: string;
    model: string;
    created_at: number;
    updated_at: number;
  }>;
}

export async function deleteConversation(id: string): Promise<void> {
  await dbExecute("DELETE FROM messages WHERE conversation_id = ?", [id]);
  await dbExecute("DELETE FROM conversations WHERE id = ?", [id]);
}

// ── Message operations ───────────────────────────────────────────────────────

export async function saveMessage(
  convId: string,
  role: string,
  content: string
): Promise<string> {
  const id = crypto.randomUUID();
  const ts = Date.now();

  await dbExecute(
    "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER)",
    []
  );

  await dbExecute(
    "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    [id, convId, role, content, ts]
  );

  // Sync FTS index
  await dbExecute(
    "INSERT INTO messages_fts (rowid, content, conversation_id) VALUES (last_insert_rowid(), ?, ?)",
    [content, convId]
  );

  await dbExecute(
    "UPDATE conversations SET updated_at = ? WHERE id = ?",
    [ts, convId]
  );

  return id;
}

export async function loadMessages(convId: string): Promise<Array<{
  id: string;
  role: string;
  content: string;
  timestamp: number;
}>> {
  await dbExecute(
    "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER)",
    []
  );

  // Create FTS5 virtual table for full-text search
  await dbExecute(
    `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
     USING fts5(content, conversation_id, content=messages, content_rowid=rowid)`,
    []
  );

  const rows = await dbSelect(
    "SELECT id, role, content, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp",
    [convId]
  );

  return rows as Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
  }>;
}

export async function deleteMessage(id: string): Promise<void> {
  await dbExecute("DELETE FROM messages WHERE id = ?", [id]);
}

// ── Full-Text Search ─────────────────────────────────────────────────────────

export async function searchMessages(query: string, limit?: number): Promise<Array<{
  content: string;
  conversation_id: string;
  timestamp: number;
}>> {
  if (!query.trim()) return [];
  try {
    // Create FTS table if not exists (idempotent)
    await dbExecute(
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
       USING fts5(content, conversation_id, content=messages, content_rowid=rowid)`,
      []
    );

    const rows = await dbSelect(
      `SELECT m.content, m.conversation_id, m.timestamp
       FROM messages m
       JOIN messages_fts fts ON m.rowid = fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      [query, limit ?? 50]
    );

    return rows as Array<{
      content: string;
      conversation_id: string;
      timestamp: number;
    }>;
  } catch (e) {
    console.warn("[DB] searchMessages failed:", e);
    return [];
  }
}

// ── Utility functions ────────────────────────────────────────────────────────

export async function getConversationCount(): Promise<number> {
  const rows = await dbSelect("SELECT COUNT(*) as count FROM conversations", []);
  const row = rows[0] as { count: number };
  return row.count;
}

export async function clearAllData(): Promise<void> {
  await dbExecute("DELETE FROM messages", []);
  await dbExecute("DELETE FROM conversations", []);
}
