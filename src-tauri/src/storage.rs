#![allow(dead_code)]

use tauri::AppHandle;

#[derive(Clone)]
pub struct StorageManager;

impl StorageManager {
  pub fn new(_app: &AppHandle) -> Result<Self, String> {
    Ok(Self)
  }
}
