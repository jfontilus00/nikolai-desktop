import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/api/dialog";
import { createTwoFilesPatch } from "diff";
import {
  wsGetRoot, wsListDir, wsMkdir, wsReadText, wsSetRoot, wsWriteText,
  wsBatchApply, wsBatchRollback, type WsEntry, type BatchFile,
} from "../lib/workspaceClient";
import { loadJSON, saveJSON } from "../lib/storage";
import {
  buildIndex, saveIndex, clearIndex, getIndexMeta,
  type BuildProgress, type IndexMeta,
} from "../lib/semanticIndex";

const KEY_WS_ROOT = "nikolai.workspace.root.v1";
const KEY_WS_LAST_BATCH = "nikolai.workspace.lastBatch.v1";

function parentDir(rel: string) {
  const r = (rel || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!r) return "";
  const idx = r.lastIndexOf("/");
  return idx <= 0 ? "" : r.slice(0, idx);
}

function normalizeRel(p: string) {
  return String(p || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function parseBatchJson(raw: string): { files: BatchFile[] } | { error: string } {
  const s = (raw || "").trim();
  if (!s) return { error: "Paste JSON first." };

  let val: any;
  try {
    val = JSON.parse(s);
  } catch (e: any) {
    return { error: `Invalid JSON: ${e?.message || String(e)}` };
  }

  const filesVal = Array.isArray(val) ? val : val?.files;
  if (!Array.isArray(filesVal)) return { error: "JSON must be an array OR an object with { files: [...] }" };

  const files: BatchFile[] = [];
  for (let i = 0; i < filesVal.length; i++) {
    const it = filesVal[i];
    const path = normalizeRel(String(it?.path ?? it?.file ?? it?.rel ?? ""));
    const content = it?.content;

    if (!path) return { error: `files[${i}] missing "path"` };
    if (typeof content !== "string") return { error: `files[${i}].content must be a string` };

    files.push({ path, content });
  }

  if (files.length === 0) return { error: "No files found in batch." };
  return { files };
}

export default function WorkspacePanel() {
  const [root, setRoot] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<WsEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const [original, setOriginal] = useState<string>("");
  const [draft, setDraft] = useState<string>("");

  const [busy, setBusy]     = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // ── V5: Semantic index state ───────────────────────────────────────────────
  const [indexMeta,     setIndexMeta]     = useState<IndexMeta | null>(null);
  const [indexBusy,     setIndexBusy]     = useState(false);
  const [indexProgress, setIndexProgress] = useState<BuildProgress | null>(null);
  const [indexError,    setIndexError]    = useState<string | null>(null);
  const [embedModel,    setEmbedModel]    = useState("nomic-embed-text");
  const indexAbortRef = { current: null as AbortController | null };

  // Batch UI
  const [batchJson, setBatchJson] = useState<string>(() => loadJSON<string>(KEY_WS_LAST_BATCH + ":draft", ""));
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [batchPreview, setBatchPreview] = useState<BatchFile[] | null>(null);
  const [batchIdInput, setBatchIdInput] = useState<string>("");
  const [lastBatchId, setLastBatchId] = useState<string | null>(() => loadJSON<string | null>(KEY_WS_LAST_BATCH, null));

  // ── Auto-refresh after agent batch commit ──────────────────────────────────
  // agentic.ts dispatches "nikolai:batch-committed" after ws_batch_apply succeeds.
  // We refresh the file list immediately and highlight the written files for 4s.
  const [highlightedFiles, setHighlightedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handler = (e: Event) => {
      const { batch_id, files } = (e as CustomEvent).detail as {
        batch_id: string;
        applied: number;
        files: string[];
      };

      // Update last batch id display
      setLastBatchId(batch_id);
      saveJSON(KEY_WS_LAST_BATCH, batch_id);

      // Highlight written files (just the basename for matching)
      const names = new Set(files.map((f) => f.replace(/\\/g, "/").split("/").pop() ?? f));
      setHighlightedFiles(names);
      setTimeout(() => setHighlightedFiles(new Set()), 4000);

      // Refresh directory listing
      void refreshDir();
    };
    window.addEventListener("nikolai:batch-committed", handler);
    return () => window.removeEventListener("nikolai:batch-committed", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // ── Backup browser ─────────────────────────────────────────────────────────
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupBatches, setBackupBatches] = useState<WsEntry[]>([]);
  const [backupBatchId, setBackupBatchId] = useState<string | null>(null);
  const [backupFiles, setBackupFiles] = useState<WsEntry[]>([]);
  const [backupPreviewFile, setBackupPreviewFile] = useState<string | null>(null);
  const [backupPreviewContent, setBackupPreviewContent] = useState<string>("");

  async function openBackupBrowser() {
    setBackupOpen(true);
    setBackupBatchId(null);
    setBackupFiles([]);
    setBackupPreviewFile(null);
    setBackupPreviewContent("");
    try {
      const list = await wsListDir(".nikolai_backups/batches", 4000);
      setBackupBatches(list.filter((e) => e.is_dir));
    } catch {
      setBackupBatches([]);
    }
  }

  async function openBackupBatch(batchId: string) {
    setBackupBatchId(batchId);
    setBackupPreviewFile(null);
    setBackupPreviewContent("");
    try {
      const list = await wsListDir(`.nikolai_backups/batches/${batchId}`, 4000);
      setBackupFiles(list.filter((e) => !e.is_dir && !e.name.endsWith("manifest.jsonl")));
    } catch {
      setBackupFiles([]);
    }
  }

  async function previewBackupFile(rel: string) {
    setBackupPreviewFile(rel);
    try {
      const txt = await wsReadText(rel);
      setBackupPreviewContent(txt);
    } catch (e: any) {
      setBackupPreviewContent(`Error reading file: ${e?.message || String(e)}`);
    }
  }

  async function restoreBackupFile(backupRel: string, targetName: string) {
    if (!backupBatchId) return;
    // Target path = file name without .bak extension, in current workspace
    const target = targetName.replace(/\.bak$/, "");
    const ok = confirm(`Restore this backup file to:\n${target}\n\nThis will overwrite the current version.`);
    if (!ok) return;
    try {
      const content = await wsReadText(backupRel);
      await wsWriteText(target, content, true);
      setStatus(`Restored: ${target}`);
      await refreshDir(cwd);
    } catch (e: any) {
      setStatus(`Restore failed: ${e?.message || String(e)}`);
    }
  }

  const diffText = useMemo(() => {
    if (!selectedFile) return "";
    if (draft === original) return "No changes.";
    return createTwoFilesPatch(selectedFile, selectedFile, original ?? "", draft ?? "", "before", "after");
  }, [selectedFile, original, draft]);

  async function refreshDir(nextCwd?: string) {
    const dir = typeof nextCwd === "string" ? nextCwd : cwd;
    setBusy("Loading directory...");
    setStatus(null);
    try {
      const list = await wsListDir(dir, 4000);
      setEntries(list);
    } catch (e: any) {
      setStatus(`List dir failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  // ── V5: Semantic index functions ──────────────────────────────────────────

  function readOllamaBaseUrl(): string {
    try {
      const profiles  = JSON.parse(localStorage.getItem("nikolai.provider.profiles.v1") || "[]");
      const activeId  = localStorage.getItem("nikolai.provider.active.v1");
      const active    = profiles.find((p: any) => p.id === activeId) ?? profiles[0];
      return (active?.provider?.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
    } catch {
      return "http://127.0.0.1:11434";
    }
  }

  async function startBuildIndex() {
    if (!root) { setIndexError("Set a workspace root first."); return; }
    if (indexBusy) return;

    setIndexBusy(true);
    setIndexError(null);
    setIndexProgress(null);

    const ctrl = new AbortController();
    indexAbortRef.current = ctrl;
    const baseUrl = readOllamaBaseUrl();

    try {
      const index = await buildIndex({
        root,
        baseUrl,
        model:    embedModel,
        maxFiles: 120,
        signal:   ctrl.signal,
        onProgress: (p) => setIndexProgress(p),
        listDir: async (rel) => {
          const entries = await wsListDir(rel || ".", 500);
          return entries.map((e) => ({ name: e.name, is_dir: e.is_dir, rel: e.rel }));
        },
        readFile: async (rel) => {
          try { return await wsReadText(rel); } catch { return ""; }
        },
      });
      const saved = saveIndex(root, index);
      setIndexMeta(getIndexMeta(root));
      if (!saved) setIndexError("⚠ Index built but localStorage is full — some chunks were dropped.");
    } catch (e: any) {
      if (e?.message !== "Aborted by user") setIndexError(e?.message || String(e));
      setIndexProgress(null);
    } finally {
      setIndexBusy(false);
      indexAbortRef.current = null;
    }
  }

  function abortBuildIndex() {
    indexAbortRef.current?.abort();
    setIndexBusy(false);
    setIndexProgress(null);
  }

  function dropIndex() {
    if (!root) return;
    if (!confirm("Delete the semantic index for this workspace?\nYou can rebuild it at any time.")) return;
    clearIndex(root);
    setIndexMeta(null);
    setIndexProgress(null);
    setIndexError(null);
  }

  useEffect(() => {
    const init = async () => {
      const r = await wsGetRoot();
      if (r) {
        setRoot(r);
        setIndexMeta(getIndexMeta(r));   // ← V5: load index meta on startup
        await refreshDir("");
        return;
      }
      const saved = loadJSON<string | null>(KEY_WS_ROOT, null);
      if (saved) {
        try {
          const rr = await wsSetRoot(saved);
          setRoot(rr);
          setIndexMeta(getIndexMeta(rr)); // ← V5: load index meta on startup
          await refreshDir("");
        } catch (e: any) {
          setStatus(`Could not restore workspace root: ${e?.message || String(e)}`);
        }
      }
    };
    init().catch((e: any) => setStatus(`Init failed: ${e?.message || String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live-parse batch JSON
  useEffect(() => {
    saveJSON(KEY_WS_LAST_BATCH + ":draft", batchJson);
    const parsed = parseBatchJson(batchJson);
    if ("error" in parsed) {
      setBatchErr(parsed.error);
      setBatchPreview(null);
    } else {
      setBatchErr(null);
      setBatchPreview(parsed.files);
    }
  }, [batchJson]);

  // FIX: wrapped in try/catch — previously open() could throw silently
  async function chooseRoot() {
    setStatus(null);
    try {
      const picked = await open({ directory: true, multiple: false });
      if (!picked || typeof picked !== "string") return;

      setBusy("Setting workspace root...");
      const rr = await wsSetRoot(picked);
      saveJSON(KEY_WS_ROOT, rr);
      setRoot(rr);
      setCwd("");
      setSelectedFile(null);
      setOriginal("");
      setDraft("");
      await refreshDir("");
      setStatus("Workspace root set.");
    } catch (e: any) {
      setStatus(`Choose root failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function openEntry(ent: WsEntry) {
    setStatus(null);
    if (ent.is_dir) {
      setCwd(ent.rel);
      setSelectedFile(null);
      setOriginal("");
      setDraft("");
      await refreshDir(ent.rel);
      return;
    }

    setBusy("Reading file...");
    try {
      const txt = await wsReadText(ent.rel);
      setSelectedFile(ent.rel);
      setOriginal(txt);
      setDraft(txt);
    } catch (e: any) {
      setStatus(`Read failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function newFolder() {
    if (!root) return;
    const name = prompt("New folder name (relative to current folder)", "new-folder");
    if (!name) return;

    const rel = (cwd ? `${cwd}/${name}` : name).replace(/\\/g, "/");
    setBusy("Creating folder...");
    try {
      await wsMkdir(rel);
      await refreshDir(cwd);
      setStatus("Folder created.");
    } catch (e: any) {
      setStatus(`mkdir failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function newFile() {
    if (!root) return;
    const name = prompt("New file name (relative to current folder)", "new-file.txt");
    if (!name) return;

    const rel = (cwd ? `${cwd}/${name}` : name).replace(/\\/g, "/");
    setBusy("Creating file...");
    try {
      await wsWriteText(rel, "", false);
      await refreshDir(cwd);
      setStatus("File created.");
    } catch (e: any) {
      setStatus(`Create file failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function applyChanges() {
    if (!selectedFile) return;

    if (draft === original) {
      setStatus("No changes to apply.");
      return;
    }

    const ok = confirm(`Apply changes to:\n${selectedFile}\n\nA backup will be created in .nikolai_backups/`);
    if (!ok) return;

    setBusy("Applying (with backup)...");
    setStatus(null);
    try {
      await wsWriteText(selectedFile, draft, true);
      setOriginal(draft);
      setStatus("Applied. Backup saved to .nikolai_backups/ (see manifest.jsonl).");
    } catch (e: any) {
      setStatus(`Apply failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function applyBatch() {
    if (!root) return;
    const parsed = parseBatchJson(batchJson);
    if ("error" in parsed) {
      setStatus(parsed.error);
      return;
    }

    const files = parsed.files;
    const ok = confirm(
      `Apply batch to ${files.length} file(s)?\n\nA batch backup will be created in:\n.nikolai_backups/batches/<batch_id>/`
    );
    if (!ok) return;

    setBusy("Applying batch...");
    setStatus(null);
    try {
      const res = await wsBatchApply(files);
      setLastBatchId(res.batch_id);
      saveJSON(KEY_WS_LAST_BATCH, res.batch_id);
      setStatus(`Batch applied: ${res.batch_id} (files: ${res.applied}). You can rollback this batch.`);
      await refreshDir(cwd);
    } catch (e: any) {
      setStatus(`Batch apply failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function rollbackBatch(batchId?: string | null) {
    if (!root) return;
    const id = (batchId || "").trim() || null;

    const ok = confirm(
      id
        ? `Rollback batch:\n${id}\n\nThis will restore/delete files recorded in that batch.`
        : `Rollback latest batch?\n\nThis will restore/delete files recorded in the newest batch.`
    );
    if (!ok) return;

    setBusy("Rolling back batch...");
    setStatus(null);
    try {
      const res = await wsBatchRollback(id);
      setLastBatchId(res.batch_id);
      saveJSON(KEY_WS_LAST_BATCH, res.batch_id);
      setStatus(`Rolled back batch: ${res.batch_id} (restored: ${res.restored}, deleted: ${res.deleted}).`);
      await refreshDir(cwd);
    } catch (e: any) {
      setStatus(`Rollback failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold opacity-80">Workspace Mode</div>
        {/* FIX: type="button" prevents form submit default */}
        <button
          type="button"
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
          onClick={chooseRoot}
        >
          Choose root
        </button>
      </div>

      <div className="text-[11px] opacity-70 break-all">
        <div><span className="opacity-60">Root:</span> {root || "(not set)"}</div>
        <div><span className="opacity-60">Folder:</span> /{cwd || ""}</div>
      </div>

      {/* Tauri context check — helps diagnose "nothing happens" in dev */}
      {typeof window !== "undefined" && !(window as any).__TAURI__ && (
        <div className="text-[11px] text-amber-400 border border-amber-400/30 rounded px-2 py-1.5">
          ⚠ Tauri IPC not detected. Workspace features only work inside the desktop app,
          not in a plain browser. Run via <code>npm run tauri dev</code>.
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
          onClick={() => void refreshDir(cwd)}
          disabled={!root}
        >
          Refresh
        </button>
        <button
          type="button"
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
          onClick={() => {
            const p = parentDir(cwd);
            setCwd(p);
            void refreshDir(p);
          }}
          disabled={!root || !cwd}
        >
          Up
        </button>
        <button
          type="button"
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
          onClick={() => void newFolder()}
          disabled={!root || !!busy}
        >
          New folder
        </button>
        <button
          type="button"
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
          onClick={() => void newFile()}
          disabled={!root || !!busy}
        >
          New file
        </button>
      </div>

      {busy   ? <div className="text-xs text-amber-300 animate-pulse">{busy}</div>   : null}
      {status ? <div className={`text-xs ${status.toLowerCase().includes("fail") || status.toLowerCase().includes("error") ? "text-red-400" : "text-emerald-400"}`}>{status}</div> : null}

      <div className="border border-white/10 rounded-lg bg-white/5">
        <div className="px-3 py-2 border-b border-white/10 text-xs font-semibold opacity-80">Files</div>
        <div className="max-h-52 overflow-auto">
          {entries.length === 0 ? (
            <div className="p-3 text-xs opacity-60">{root ? "No entries." : "Set a workspace root first."}</div>
          ) : (
            entries.map((e) => (
              <button
                type="button"
                key={e.rel}
                className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between transition-colors ${
                  highlightedFiles.has(e.name)
                    ? "bg-emerald-500/15 hover:bg-emerald-500/20"
                    : "hover:bg-white/10"
                }`}
                onClick={() => void openEntry(e)}
                disabled={!!busy}
              >
                <span className="truncate flex items-center gap-1.5">
                  {highlightedFiles.has(e.name) && (
                    <span className="text-emerald-400 text-[10px] font-bold">NEW</span>
                  )}
                  {e.is_dir ? "📁 " : "📄 "}{e.name}
                </span>
                {!e.is_dir && typeof e.size === "number"
                  ? <span className="text-xs opacity-50">{e.size} B</span>
                  : null}
              </button>
            ))
          )}
        </div>
      </div>

      {selectedFile ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold opacity-80">Editing: {selectedFile}</div>

          <textarea
            className="w-full min-h-[180px] rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30 font-mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />

          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-sm font-semibold"
              onClick={() => void applyChanges()}
              disabled={!!busy}
            >
              Apply (backup + write)
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm"
              onClick={() => setDraft(original)}
              disabled={!!busy}
            >
              Revert draft
            </button>
          </div>

          <div className="border border-white/10 rounded-lg bg-white/5">
            <div className="px-3 py-2 border-b border-white/10 text-xs font-semibold opacity-80">Diff preview</div>
            <pre className="p-3 text-[11px] overflow-auto whitespace-pre-wrap">{diffText}</pre>
          </div>
        </div>
      ) : null}

      {/* Batch apply section */}
      <div className="border border-white/10 rounded-lg bg-white/5">
        <div className="px-3 py-2 border-b border-white/10 text-xs font-semibold opacity-80">
          Batch apply (JSON)
        </div>
        <div className="p-3 space-y-2">
          <textarea
            className="w-full min-h-[160px] rounded-md bg-black/30 border border-white/10 px-3 py-2 text-[12px] outline-none focus:border-white/30 font-mono"
            value={batchJson}
            onChange={(e) => setBatchJson(e.target.value)}
            placeholder={'{ "files": [{ "path": "src/a.ts", "content": "..." }] }'}
            disabled={!root || !!busy}
          />

          {batchErr ? <div className="text-[11px] text-amber-300">{batchErr}</div> : null}

          {batchPreview ? (
            <div className="text-[11px] opacity-70 space-y-1">
              <div className="opacity-80">Preview ({batchPreview.length} file(s)):</div>
              <ul className="list-disc pl-5 space-y-0.5">
                {batchPreview.slice(0, 20).map((f) => (
                  <li key={f.path}>
                    <span className="opacity-90">{f.path}</span>
                    <span className="opacity-60"> — {f.content.length} chars</span>
                  </li>
                ))}
              </ul>
              {batchPreview.length > 20
                ? <div className="opacity-60">...and {batchPreview.length - 20} more</div>
                : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-sm font-semibold disabled:opacity-50"
              onClick={() => void applyBatch()}
              disabled={!root || !!busy || !!batchErr || !batchPreview}
            >
              Apply batch (backup + write)
            </button>

            <button
              type="button"
              className="px-3 py-2 rounded-md bg-amber-600 hover:bg-amber-500 text-sm font-semibold disabled:opacity-50"
              onClick={() => void rollbackBatch(lastBatchId)}
              disabled={!root || !!busy}
              title={lastBatchId ? `Rollback last batch: ${lastBatchId}` : "Rollback latest batch found on disk"}
            >
              Rollback last batch
            </button>

            <div className="flex items-center gap-2">
              <input
                className="w-[220px] px-3 py-2 rounded-md bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30"
                value={batchIdInput}
                onChange={(e) => setBatchIdInput(e.target.value)}
                placeholder="batch id (optional)"
                disabled={!root || !!busy}
              />
              <button
                type="button"
                className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-sm disabled:opacity-50"
                onClick={() => void rollbackBatch(batchIdInput)}
                disabled={!root || !!busy}
              >
                Rollback by ID
              </button>
            </div>

            <div className="text-[11px] opacity-60">
              Last batch: {lastBatchId || "—"}
            </div>
          </div>

          <div className="text-[11px] opacity-60">
            Batches stored under{" "}
            <code className="px-1 py-0.5 rounded bg-black/30 border border-white/10">
              .nikolai_backups/batches/
            </code>
          </div>
        </div>
      </div>

      {/* ── Backup Browser ─────────────────────────────────────────────── */}
      <div className="border border-white/10 rounded-lg bg-white/5">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold opacity-80 hover:opacity-100"
          onClick={() => (backupOpen ? setBackupOpen(false) : void openBackupBrowser())}
          disabled={!root}
        >
          <span>📦 Backup Browser</span>
          <span className="opacity-50">{backupOpen ? "▲" : "▼"}</span>
        </button>

        {backupOpen && (
          <div className="border-t border-white/10 p-3 space-y-2">
            {backupBatches.length === 0 ? (
              <div className="text-[11px] opacity-50">No batches found in .nikolai_backups/batches/</div>
            ) : (
              <>
                <div className="text-[11px] opacity-60">{backupBatches.length} batch(es) found — click to browse</div>
                <div className="max-h-32 overflow-auto space-y-1">
                  {backupBatches.map((b) => (
                    <button
                      type="button"
                      key={b.rel}
                      className={`w-full text-left px-2 py-1.5 rounded text-[11px] font-mono border transition-colors ${
                        backupBatchId === b.name
                          ? "bg-white/10 border-white/20"
                          : "bg-white/5 hover:bg-white/10 border-white/10"
                      }`}
                      onClick={() => void openBackupBatch(b.name)}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              </>
            )}

            {backupBatchId && (
              <div className="border-t border-white/10 pt-2 space-y-1">
                <div className="text-[11px] opacity-70 font-semibold">Files in batch: {backupBatchId}</div>
                {backupFiles.length === 0 ? (
                  <div className="text-[11px] opacity-50">No backup files found.</div>
                ) : (
                  <div className="max-h-28 overflow-auto space-y-1">
                    {backupFiles.map((f) => (
                      <div key={f.rel} className="flex items-center gap-2">
                        <button
                          type="button"
                          className={`flex-1 text-left px-2 py-1 rounded text-[11px] font-mono border transition-colors truncate ${
                            backupPreviewFile === f.rel
                              ? "bg-white/10 border-white/20"
                              : "bg-white/5 hover:bg-white/10 border-white/10"
                          }`}
                          onClick={() => void previewBackupFile(f.rel)}
                        >
                          {f.name}
                        </button>
                        <button
                          type="button"
                          className="px-2 py-1 rounded text-[11px] bg-amber-600/80 hover:bg-amber-500 border border-amber-500/30 flex-shrink-0"
                          onClick={() => void restoreBackupFile(f.rel, f.name)}
                          title={`Restore ${f.name} to workspace`}
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {backupPreviewFile && backupPreviewContent && (
              <div className="border-t border-white/10 pt-2">
                <div className="text-[11px] opacity-60 mb-1">Preview: {backupPreviewFile.split("/").pop()}</div>
                <pre className="max-h-40 overflow-auto text-[10px] bg-black/30 border border-white/10 rounded p-2 whitespace-pre-wrap break-words opacity-80">
                  {backupPreviewContent.slice(0, 2000)}
                  {backupPreviewContent.length > 2000 ? "\n…(truncated)" : ""}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── V5: Semantic Index ──────────────────────────────────────────────── */}
      <div className="border border-indigo-500/20 rounded-lg bg-indigo-500/5">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold opacity-90">🧠 Semantic Index</span>
            {indexMeta ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/20">
                Ready
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/40 border border-white/10">
                Not built
              </span>
            )}
          </div>
          {indexMeta && (
            <span className="text-[10px] opacity-40">
              {indexMeta.chunk_count} chunks · {indexMeta.file_count} files · {indexMeta.model}
            </span>
          )}
        </div>

        <div className="border-t border-white/10 px-3 py-2.5 space-y-2.5">

          {/* What this does */}
          <p className="text-[11px] text-white/50 leading-relaxed">
            Embeds your codebase so the agent can find files by <em>meaning</em> in one step
            instead of 3–5 list/read cycles. Requires <code className="bg-white/10 px-1 rounded">ollama pull nomic-embed-text</code> (~274 MB, once).
          </p>

          {/* Model selector */}
          <div className="flex items-center gap-2">
            <label className="text-[11px] opacity-60 flex-shrink-0">Model</label>
            <input
              className="flex-1 rounded bg-black/30 border border-white/10 px-2 py-1 text-[11px] font-mono outline-none focus:border-indigo-400/40"
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value.trim())}
              placeholder="nomic-embed-text"
            />
          </div>

          {/* Build / abort / drop buttons */}
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              className="px-3 py-1.5 rounded bg-indigo-600/70 hover:bg-indigo-500/70 border border-indigo-400/20 text-xs font-semibold disabled:opacity-40"
              onClick={() => void startBuildIndex()}
              disabled={indexBusy || !root}
              title={!root ? "Set a workspace root first" : "Scan + embed workspace files"}
            >
              {indexBusy ? "⏳ Building…" : (indexMeta ? "🔄 Rebuild" : "⚡ Build Index")}
            </button>

            {indexBusy && (
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-red-600/60 hover:bg-red-500/60 border border-red-400/20 text-xs"
                onClick={abortBuildIndex}
              >
                ✕ Cancel
              </button>
            )}

            {indexMeta && !indexBusy && (
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 border border-white/10 text-xs opacity-60 hover:opacity-100"
                onClick={dropIndex}
              >
                🗑 Delete index
              </button>
            )}
          </div>

          {/* Progress bar */}
          {indexProgress && indexProgress.phase !== "done" && (
            <div className="space-y-1">
              <div className="text-[10px] text-indigo-300/80 truncate">{indexProgress.message}</div>
              {indexProgress.total > 0 && (
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-200"
                    style={{ width: `${Math.round((indexProgress.current / indexProgress.total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Done message */}
          {indexProgress?.phase === "done" && (
            <div className="text-[11px] text-emerald-400/80">{indexProgress.message}</div>
          )}

          {/* Built-at timestamp */}
          {indexMeta && (
            <div className="text-[10px] opacity-30">
              Last built: {new Date(indexMeta.built_at).toLocaleString()}
            </div>
          )}

          {/* Error */}
          {indexError && (
            <div className="text-[11px] text-red-400/80 whitespace-pre-wrap leading-relaxed">
              {indexError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}