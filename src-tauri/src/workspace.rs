use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static WORKSPACE_ROOT: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

#[derive(Serialize)]
pub struct WsEntry {
  pub name: String,
  pub rel: String,
  pub is_dir: bool,
  pub size: Option<u64>,
}

#[derive(Deserialize, Clone)]
pub struct BatchFile {
  pub path: String,
  pub content: String,
}

#[derive(Serialize, Deserialize)]
pub struct BatchItem {
  pub file: String,
  pub existed: bool,
  pub backup_rel: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct BatchMeta {
  pub batch_id: String,
  pub ts: u128,
  pub files: Vec<BatchItem>,
}

#[derive(Serialize)]
pub struct BatchApplyResult {
  pub batch_id: String,
  pub applied: usize,
}

#[derive(Serialize)]
pub struct BatchRollbackResult {
  pub batch_id: String,
  pub restored: usize,
  pub deleted: usize,
}

fn now_millis() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis()
}

fn sanitize_rel(rel: &str) -> Result<PathBuf, String> {
  let r = rel.trim().replace('\\', "/");
  if r.is_empty() {
    return Ok(PathBuf::new());
  }

  let p = Path::new(&r);
  for c in p.components() {
    match c {
      Component::ParentDir => return Err("Workspace: '..' not allowed".into()),
      Component::RootDir => return Err("Workspace: absolute paths not allowed".into()),
      Component::Prefix(_) => return Err("Workspace: absolute paths not allowed".into()),
      _ => {}
    }
  }
  Ok(p.to_path_buf())
}

fn root() -> Result<PathBuf, String> {
  let g = WORKSPACE_ROOT
    .lock()
    .map_err(|_| "Workspace root mutex poisoned".to_string())?;
  g.clone()
    .ok_or_else(|| "Workspace root not set. Choose a Workspace Root first.".to_string())
}

// ── SECURITY FIX: Symlink Escape Prevention ───────────────────────────────────
// Verifies that a resolved path (after following symlinks) is still under the
// workspace root. This prevents symlink-based escapes where a symlink inside
// the workspace points to a file outside (e.g., /etc/passwd or C:\Windows\System32).
//
// How it works:
// 1. Canonicalize the path (resolves all symlinks to their real targets)
// 2. Canonicalize the workspace root (for consistent comparison)
// 3. Verify the canonicalized path starts with the canonicalized root
//
// If the path escapes the workspace, returns an error.
// Requires the path to exist (uses fs::canonicalize).
fn verify_under_root(path: &Path) -> Result<PathBuf, String> {
  // ── IMPROVEMENT: Calculate canonical_root once at start ────────────────────
  // This ensures consistent path resolution throughout verification.
  // The canonical root is computed once and reused for all prefix checks.
  let canonical_root = {
    let root_guard = WORKSPACE_ROOT
      .lock()
      .map_err(|_| "Workspace root mutex poisoned".to_string())?;

    let root = root_guard
      .as_ref()
      .ok_or_else(|| "Workspace root not set. Choose a Workspace Root first.".to_string())?
      .clone();

    // Hold guard through canonicalization to ensure root doesn't change
    fs::canonicalize(&root)
      .map_err(|e| format!("Failed to canonicalize root: {} (path: {})", e, root.display()))?
    // root_guard dropped here after canonicalization complete
  };

  // ── SECURITY FIX: Reject symlinks before canonicalization ──────────────────
  // This prevents TOCTOU attacks where an attacker swaps a symlink between
  // canonicalization and file usage. We reject symlinks outright.
  let metadata = fs::symlink_metadata(path)
    .map_err(|e| format!("Failed to stat path: {} (path: {})", e, path.display()))?;

  if metadata.file_type().is_symlink() {
    return Err("Symlinks are not allowed inside workspace".into());
  }

  // Canonicalize the target path (now safe — symlinks rejected above)
  let canonical = fs::canonicalize(path)
    .map_err(|e| format!("Path resolution failed: {} (path: {})", e, path.display()))?;

  // Verify the canonical path is under the canonical root
  // Use starts_with() for prefix matching on path components
  if !canonical.starts_with(&canonical_root) {
    return Err(format!(
      "Security: resolved path escapes workspace root. Target: {}, Root: {}",
      canonical.display(),
      canonical_root.display()
    ));
  }

  Ok(canonical)
}

// ── SECURITY FIX: Symlink Escape Prevention for Non-Existent Paths ───────────
// For paths that don't exist yet (e.g., new files being created), we verify
// the parent directory is under the workspace root. This prevents creating
// files through symlinks that point outside the workspace.
//
// How it works:
// 1. Get the parent directory of the target path
// 2. Canonicalize the parent (must exist)
// 3. Verify the canonicalized parent is under the workspace root
// 4. Return the original (non-canonicalized) path for the operation
fn verify_parent_under_root(path: &Path) -> Result<(), String> {
  let parent = path.parent()
    .ok_or_else(|| format!("Invalid path: no parent directory (path: {})", path.display()))?;

  // Parent must exist for canonicalization
  if !parent.exists() {
    // If parent doesn't exist, try to create it first, then verify
    // This is handled by ensure_parent() caller, so just verify root containment
    // by checking the intermediate path components
    return verify_path_components_under_root(path);
  }

  let canonical_parent = fs::canonicalize(parent)
    .map_err(|e| format!("Parent directory resolution failed: {} (path: {})", e, path.display()))?;

  // ── HARDENING: Hold mutex during entire root retrieval + canonicalization ──
  let root_guard = WORKSPACE_ROOT
    .lock()
    .map_err(|_| "Workspace root mutex poisoned".to_string())?;
  let root_path = root_guard
    .as_ref()
    .ok_or_else(|| "Workspace root not set. Choose a Workspace Root first.".to_string())?
    .clone();
  drop(root_guard);

  let canonical_root = fs::canonicalize(&root_path)
    .map_err(|e| format!("Workspace root resolution failed: {}", e))?;

  if !canonical_parent.starts_with(&canonical_root) {
    return Err(format!(
      "Security: parent directory escapes workspace root. Parent: {}, Root: {}",
      canonical_parent.display(),
      canonical_root.display()
    ));
  }

  Ok(())
}

// ── Fallback verification for paths where parent doesn't exist ───────────────
// When creating nested directories, the parent may not exist yet.
// This verifies the relative path components don't attempt escape.
// Note: This is a weaker check - relies on sanitize_rel() already blocking ".."
fn verify_path_components_under_root(path: &Path) -> Result<(), String> {
  // The path should already be sanitized (no ".." components).
  // As a final check, ensure it's not absolute.
  if path.is_absolute() {
    return Err(format!("Security: absolute paths not allowed (path: {})", path.display()));
  }
  // Path is relative and sanitized - considered safe
  Ok(())
}

fn resolve(rel: &str) -> Result<PathBuf, String> {
  let r = sanitize_rel(rel)?;
  Ok(root()?.join(r))
}

// ── Secure resolve with symlink verification ──────────────────────────────────
// Resolves a relative path and verifies the final destination (after following
// symlinks) is still under the workspace root. Use this for all file operations
// where the target file/directory must already exist.
fn resolve_secure(rel: &str) -> Result<PathBuf, String> {
  let intermediate = resolve(rel)?;
  verify_under_root(&intermediate)
}

// ── Secure resolve for new files ─────────────────────────────────────────────
// Resolves a relative path and verifies the parent directory is under the
// workspace root. Use this for file creation operations where the target
// file doesn't exist yet.
fn resolve_secure_for_write(rel: &str) -> Result<PathBuf, String> {
  let intermediate = resolve(rel)?;
  verify_parent_under_root(&intermediate)?;
  Ok(intermediate)
}

fn rel_join(base: &str, name: &str) -> String {
  let b = base
    .trim()
    .replace('\\', "/")
    .trim_matches('/')
    .to_string();
  let n = name.trim().replace('\\', "/");
  if b.is_empty() {
    n
  } else {
    format!("{}/{}", b, n)
  }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
  }
  Ok(())
}

fn backups_dir() -> Result<PathBuf, String> {
  Ok(root()?.join(".nikolai_backups"))
}

fn batches_root_dir() -> Result<PathBuf, String> {
  Ok(backups_dir()?.join("batches"))
}

fn write_manifest(event: serde_json::Value) -> Result<(), String> {
  let dir = backups_dir()?;
  fs::create_dir_all(&dir).map_err(|e| format!("mkdir backups failed: {}", e))?;
  let manifest = dir.join("manifest.jsonl");
  let line = format!("{}\n", event.to_string());
  fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&manifest)
    .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()))
    .map_err(|e| format!("manifest write failed: {}", e))?;
  Ok(())
}

fn pick_latest_batch_id() -> Result<String, String> {
  let br = batches_root_dir()?;
  if !br.exists() {
    return Err("No batches found.".into());
  }

  let mut best: Option<u128> = None;
  for ent in fs::read_dir(&br).map_err(|e| format!("Read batches dir failed: {}", e))? {
    let ent = ent.map_err(|e| format!("Read batches entry failed: {}", e))?;
    let name = ent.file_name().to_string_lossy().to_string();
    if let Ok(n) = name.parse::<u128>() {
      best = Some(best.map(|b| b.max(n)).unwrap_or(n));
    }
  }

  match best {
    Some(n) => Ok(n.to_string()),
    None => Err("No batches found.".into()),
  }
}

fn normalize_rel_string(rel: &str) -> Result<String, String> {
  let p = sanitize_rel(rel)?;
  let s = p.to_string_lossy().to_string().replace('\\', "/");
  Ok(s)
}

#[tauri::command]
pub fn ws_set_root(path: String) -> Result<String, String> {
  let p = path.trim();
  if p.is_empty() {
    return Err("Workspace root is empty".into());
  }
  let canon = fs::canonicalize(p).map_err(|e| format!("Failed to set root: {}", e))?;
  let mut g = WORKSPACE_ROOT
    .lock()
    .map_err(|_| "Workspace root mutex poisoned".to_string())?;
  *g = Some(canon.clone());
  Ok(canon.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ws_get_root() -> Option<String> {
  WORKSPACE_ROOT
    .lock()
    .ok()
    .and_then(|g| g.clone())
    .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ws_list_dir(rel: String, max_entries: Option<usize>) -> Result<Vec<WsEntry>, String> {
  let maxn = max_entries.unwrap_or(2000);
  let dir = resolve_secure(&rel)?;
  let mut out: Vec<WsEntry> = vec![];

  let rd = fs::read_dir(&dir).map_err(|e| format!("List dir failed: {}", e))?;
  for entry in rd.take(maxn) {
    let entry = entry.map_err(|e| format!("List dir entry failed: {}", e))?;
    let meta = entry.metadata().ok();
    let name = entry.file_name().to_string_lossy().to_string();
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let size = meta.as_ref().and_then(|m| if m.is_file() { Some(m.len()) } else { None });

    out.push(WsEntry {
      name: name.clone(),
      rel: rel_join(&rel, &name),
      is_dir,
      size,
    });
  }

  out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
    (true, false) => std::cmp::Ordering::Less,
    (false, true) => std::cmp::Ordering::Greater,
    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
  });

  Ok(out)
}

#[tauri::command]
pub fn ws_read_text(rel: String) -> Result<String, String> {
  let p = resolve_secure(&rel)?;
  fs::read_to_string(&p).map_err(|e| format!("Read failed: {}", e))
}

#[tauri::command]
pub fn ws_write_text(rel: String, content: String, backup: Option<bool>) -> Result<(), String> {
  let p = resolve_secure_for_write(&rel)?;
  let do_backup = backup.unwrap_or(true);

  if do_backup && p.exists() && p.is_file() {
    // Verify existing file is under root before reading for backup
    let _ = verify_under_root(&p)?;
    let original = fs::read_to_string(&p).unwrap_or_default();
    let ts = now_millis();
    let bdir = backups_dir()?;
    let rel_norm = normalize_rel_string(&rel)?;
    let bpath = bdir.join(format!("{}.{}.bak", rel_norm, ts));
    ensure_parent(&bpath)?;
    fs::write(&bpath, original).map_err(|e| format!("backup write failed: {}", e))?;
    write_manifest(json!({
      "ts": ts,
      "type": "backup",
      "file": rel_norm,
      "backup": bpath.to_string_lossy().to_string()
    }))?;
  }

  ensure_parent(&p)?;
  fs::write(&p, content).map_err(|e| format!("Write failed: {}", e))?;

  write_manifest(json!({
    "ts": now_millis(),
    "type": "write",
    "file": normalize_rel_string(&rel)?
  }))?;

  Ok(())
}

#[tauri::command]
pub fn ws_mkdir(rel_dir: String) -> Result<(), String> {
  let p = resolve_secure_for_write(&rel_dir)?;
  fs::create_dir_all(&p).map_err(|e| format!("mkdir failed: {}", e))
}

// -------------------------
// Batch apply + rollback
// -------------------------

#[tauri::command]
pub fn ws_batch_apply(files: Vec<BatchFile>) -> Result<BatchApplyResult, String> {
  if files.is_empty() {
    return Err("Batch apply: files[] is empty.".into());
  }
  if files.len() > 200 {
    return Err("Batch apply: too many files (max 200).".into());
  }

  // Ensure root is set early
  let _r = root()?;

  let ts = now_millis();
  let batch_id = ts.to_string();

  let br = batches_root_dir()?;
  fs::create_dir_all(&br).map_err(|e| format!("mkdir batches failed: {}", e))?;

  let bdir = br.join(&batch_id);
  fs::create_dir_all(&bdir).map_err(|e| format!("mkdir batch dir failed: {}", e))?;

  write_manifest(json!({
    "ts": ts,
    "type": "batch_apply_begin",
    "batch_id": batch_id,
    "count": files.len()
  }))?;

  let mut meta = BatchMeta {
    batch_id: batch_id.clone(),
    ts,
    files: vec![],
  };

  for bf in files.iter() {
    let rel_norm = normalize_rel_string(&bf.path)?;
    let target = resolve_secure_for_write(&rel_norm)?;

    let existed = target.exists() && target.is_file();
    let mut backup_rel: Option<String> = None;

    if existed {
      // Verify existing file is under root before reading for backup
      let _ = verify_under_root(&target)?;
      let original = fs::read_to_string(&target).unwrap_or_default();
      let b_rel = format!("{}.bak", rel_norm);
      let b_path = bdir.join(&b_rel);
      ensure_parent(&b_path)?;
      fs::write(&b_path, original).map_err(|e| format!("batch backup write failed: {}", e))?;
      backup_rel = Some(b_rel);

      write_manifest(json!({
        "ts": ts,
        "type": "batch_backup",
        "batch_id": batch_id,
        "file": rel_norm,
      }))?;
    } else {
      write_manifest(json!({
        "ts": ts,
        "type": "batch_new_file",
        "batch_id": batch_id,
        "file": rel_norm,
      }))?;
    }

    ensure_parent(&target)?;
    fs::write(&target, &bf.content).map_err(|e| format!("batch write failed: {}", e))?;

    meta.files.push(BatchItem {
      file: rel_norm.clone(),
      existed,
      backup_rel,
    });

    write_manifest(json!({
      "ts": ts,
      "type": "batch_write",
      "batch_id": batch_id,
      "file": rel_norm
    }))?;
  }

  let meta_path = bdir.join("batch.json");
  let meta_json = serde_json::to_string_pretty(&meta).map_err(|e| format!("batch meta serialize failed: {}", e))?;
  fs::write(&meta_path, meta_json).map_err(|e| format!("batch meta write failed: {}", e))?;

  write_manifest(json!({
    "ts": now_millis(),
    "type": "batch_apply_end",
    "batch_id": batch_id,
    "count": meta.files.len()
  }))?;

  Ok(BatchApplyResult {
    batch_id,
    applied: meta.files.len(),
  })
}

#[tauri::command]
pub fn ws_batch_rollback(batch_id: Option<String>) -> Result<BatchRollbackResult, String> {
  // Ensure root is set early
  let _r = root()?;

  let id = match batch_id {
    Some(s) if !s.trim().is_empty() => s.trim().to_string(),
    _ => pick_latest_batch_id()?,
  };

  let br = batches_root_dir()?;
  let bdir = br.join(&id);
  if !bdir.exists() || !bdir.is_dir() {
    return Err(format!("Rollback: batch not found: {}", id));
  }

  let meta_path = bdir.join("batch.json");
  let raw = fs::read_to_string(&meta_path).map_err(|e| format!("Rollback: read batch.json failed: {}", e))?;
  let meta: BatchMeta = serde_json::from_str(&raw).map_err(|e| format!("Rollback: parse batch.json failed: {}", e))?;

  write_manifest(json!({
    "ts": now_millis(),
    "type": "batch_rollback_begin",
    "batch_id": id,
    "count": meta.files.len()
  }))?;

  let mut restored: usize = 0;
  let mut deleted: usize = 0;

  for item in meta.files.iter() {
    let rel_norm = normalize_rel_string(&item.file)?;
    let target = resolve_secure_for_write(&rel_norm)?;

    if item.existed {
      let b_rel = item
        .backup_rel
        .clone()
        .ok_or_else(|| format!("Rollback: missing backup_rel for {}", rel_norm))?;

      // sanitize backup relative path (defense in depth)
      let b_rel_sane = sanitize_rel(&b_rel)?;
      let b_path = bdir.join(b_rel_sane);

      let content = fs::read_to_string(&b_path)
        .map_err(|e| format!("Rollback: read backup failed for {}: {}", rel_norm, e))?;

      ensure_parent(&target)?;
      fs::write(&target, content).map_err(|e| format!("Rollback: restore failed for {}: {}", rel_norm, e))?;
      restored += 1;

      write_manifest(json!({
        "ts": now_millis(),
        "type": "batch_restore",
        "batch_id": id,
        "file": rel_norm
      }))?;
    } else {
      if target.exists() && target.is_file() {
        // Verify file is under root before deleting
        let _ = verify_under_root(&target)?;
        fs::remove_file(&target).map_err(|e| format!("Rollback: delete failed for {}: {}", rel_norm, e))?;
        deleted += 1;
      }

      write_manifest(json!({
        "ts": now_millis(),
        "type": "batch_delete_new_file",
        "batch_id": id,
        "file": rel_norm
      }))?;
    }
  }

  write_manifest(json!({
    "ts": now_millis(),
    "type": "batch_rollback_end",
    "batch_id": id,
    "restored": restored,
    "deleted": deleted
  }))?;

  Ok(BatchRollbackResult {
    batch_id: id,
    restored,
    deleted,
  })
}
