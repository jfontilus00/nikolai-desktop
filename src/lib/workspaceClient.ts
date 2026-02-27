import { invoke } from "@tauri-apps/api/tauri";

export type WsEntry = {
  name: string;
  rel: string;
  is_dir: boolean;
  size?: number | null;
};

export type BatchFile = {
  path: string;
  content: string;
};

export type BatchApplyResult = {
  batch_id: string;
  applied: number;
};

export type BatchRollbackResult = {
  batch_id: string;
  restored: number;
  deleted: number;
};

export async function wsSetRoot(path: string): Promise<string> {
  return await invoke<string>("ws_set_root", { path });
}

export async function wsGetRoot(): Promise<string | null> {
  return await invoke<string | null>("ws_get_root");
}

export async function wsListDir(rel: string, maxEntries = 2000): Promise<WsEntry[]> {
  return await invoke<WsEntry[]>("ws_list_dir", { rel, maxEntries });
}

export async function wsReadText(rel: string): Promise<string> {
  return await invoke<string>("ws_read_text", { rel });
}

export async function wsWriteText(rel: string, content: string, backup = true): Promise<void> {
  await invoke("ws_write_text", { rel, content, backup });
}

export async function wsMkdir(relDir: string): Promise<void> {
  await invoke("ws_mkdir", { relDir });
}

// Batch
export async function wsBatchApply(files: BatchFile[]): Promise<BatchApplyResult> {
  return await invoke<BatchApplyResult>("ws_batch_apply", { files });
}

export async function wsBatchRollback(batchId?: string | null): Promise<BatchRollbackResult> {
  return await invoke<BatchRollbackResult>("ws_batch_rollback", { batch_id: batchId ?? null });
}
