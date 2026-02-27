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

fn resolve(rel: &str) -> Result<PathBuf, String> {
  let r = sanitize_rel(rel)?;
  Ok(root()?.join(r))
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
  let dir = resolve(&rel)?;
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
  let p = resolve(&rel)?;
  fs::read_to_string(&p).map_err(|e| format!("Read failed: {}", e))
}

#[tauri::command]
pub fn ws_write_text(rel: String, content: String, backup: Option<bool>) -> Result<(), String> {
  let p = resolve(&rel)?;
  let do_backup = backup.unwrap_or(true);

  if do_backup && p.exists() && p.is_file() {
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
  let p = resolve(&rel_dir)?;
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
    let target = resolve(&rel_norm)?;

    let existed = target.exists() && target.is_file();
    let mut backup_rel: Option<String> = None;

    if existed {
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
    let target = resolve(&rel_norm)?;

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
