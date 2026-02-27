use keyring::{Entry, Error as KeyringError};
use tauri::command;

// NEW: HTTP client for proxying requests (MSI-safe)
use reqwest;

const SERVICE: &str = "com.timanou.nikolai";

fn clean_key(key: &str) -> Result<String, String> {
  let k = key.trim();
  if k.is_empty() {
    return Err("key is empty".to_string());
  }
  Ok(k.to_string())
}

#[command]
pub async fn secret_set(key: String, value: String) -> Result<(), String> {
  let k = clean_key(&key)?;
  let v = value;

  tauri::async_runtime::spawn_blocking(move || {
    let entry = Entry::new(SERVICE, &k).map_err(|e| e.to_string())?;
    entry.set_password(&v).map_err(|e| e.to_string())?;
    Ok::<(), String>(())
  })
  .await
  .map_err(|e| format!("join error: {}", e))?
}

#[command]
pub async fn secret_get(key: String) -> Result<Option<String>, String> {
  let k = clean_key(&key)?;

  tauri::async_runtime::spawn_blocking(move || {
    let entry = Entry::new(SERVICE, &k).map_err(|e| e.to_string())?;
    match entry.get_password() {
      Ok(v) => Ok::<Option<String>, String>(Some(v)),
      Err(KeyringError::NoEntry) => Ok::<Option<String>, String>(None),
      Err(e) => Err(e.to_string()),
    }
  })
  .await
  .map_err(|e| format!("join error: {}", e))?
}

#[command]
pub async fn secret_delete(key: String) -> Result<(), String> {
  let k = clean_key(&key)?;

  tauri::async_runtime::spawn_blocking(move || {
    let entry = Entry::new(SERVICE, &k).map_err(|e| e.to_string())?;
    match entry.delete_password() {
      Ok(_) => Ok::<(), String>(()),
      Err(KeyringError::NoEntry) => Ok::<(), String>(()),
      Err(e) => Err(e.to_string()),
    }
  })
  .await
  .map_err(|e| format!("join error: {}", e))?
}

/* ------------------------------------------------------------------
   HTTP PROXY (FIXES MSI "FAILED TO FETCH" FOR OLLAMA / LAN ENDPOINTS)
   ------------------------------------------------------------------ */

#[command]
pub async fn http_proxy(
  method: String,
  url: String,
  headers: Option<Vec<(String, String)>>,
  body: Option<String>,
) -> Result<String, String> {
  let client = reqwest::Client::new();

  let mut req = client
    .request(
      method
        .parse()
        .map_err(|_| format!("Invalid HTTP method: {}", method))?,
      &url,
    );

  if let Some(hs) = headers {
    for (k, v) in hs {
      req = req.header(k, v);
    }
  }

  if let Some(b) = body {
    req = req.body(b);
  }

  let res = req.send().await.map_err(|e| e.to_string())?;
  let text = res.text().await.map_err(|e| e.to_string())?;
  Ok(text)
}
