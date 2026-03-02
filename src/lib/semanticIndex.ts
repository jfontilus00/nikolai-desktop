// ── Atelier NikolAi Desktop — Semantic Index (V5) ────────────────────────────
//
// Builds a vector embedding index of the workspace using Ollama's
// /api/embeddings endpoint. Default model: nomic-embed-text (~274 MB).
// One-time pull: ollama pull nomic-embed-text
//
// How it works:
//   1. Walk workspace files (skips node_modules, .git, dist, build, target…)
//   2. Chunk each file into ~400-char overlapping slices
//   3. Embed each chunk → float32[768] via Ollama
//   4. Persist index to localStorage keyed by workspace root
//
// Agent usage via synthetic tool "semantic.find":
//   {"action":"tool","name":"semantic.find","args":{"query":"auth error handling","top_k":5}}
//   → returns top-5 matching file paths + relevant code snippets
//   → replaces 3–5 steps of list_directory + read_file chains with ONE step

export type IndexChunk = {
  path:      string;    // relative path from workspace root
  chunk:     string;    // ~400 chars of source text
  start:     number;    // char offset in original file
  embedding: number[];  // 768-dim cosine-comparable vector
};

export type SemanticIndex = {
  root:       string;
  model:      string;
  built_at:   number;  // unix ms
  chunks:     IndexChunk[];
  file_count: number;
};

export type IndexMeta = {
  built_at:    number;
  chunk_count: number;
  file_count:  number;
  model:       string;
};

// ── Persistence ───────────────────────────────────────────────────────────────

function storageKey(root: string): string {
  const safe = root.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 80);
  return `nikolai.semantic.v1.${safe}`;
}

export function loadIndex(root: string): SemanticIndex | null {
  if (!root) return null;
  try {
    const raw = localStorage.getItem(storageKey(root));
    return raw ? (JSON.parse(raw) as SemanticIndex) : null;
  } catch {
    return null;
  }
}

export function saveIndex(root: string, index: SemanticIndex): boolean {
  if (!root) return false;
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(index));
    return true;
  } catch (e: any) {
    // localStorage quota exceeded — trim 30% and retry once
    if (e?.name === "QuotaExceededError" && index.chunks.length > 10) {
      try {
        const slim = { ...index, chunks: index.chunks.slice(0, Math.floor(index.chunks.length * 0.7)) };
        localStorage.setItem(storageKey(root), JSON.stringify(slim));
        return true;
      } catch { return false; }
    }
    return false;
  }
}

export function clearIndex(root: string): void {
  try { localStorage.removeItem(storageKey(root)); } catch {}
}

export function getIndexMeta(root: string): IndexMeta | null {
  const idx = loadIndex(root);
  if (!idx) return null;
  return { built_at: idx.built_at, chunk_count: idx.chunks.length, file_count: idx.file_count, model: idx.model };
}

// ── Vector math ───────────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// ── Chunking ──────────────────────────────────────────────────────────────────

const CHUNK_SIZE    = 400;
const CHUNK_OVERLAP = 80;

function chunkFile(path: string, text: string): Array<{ path: string; chunk: string; start: number }> {
  const out: Array<{ path: string; chunk: string; start: number }> = [];
  if (!text?.trim()) return out;
  let start = 0;
  while (start < text.length) {
    const slice = text.slice(start, start + CHUNK_SIZE).trim();
    if (slice.length > 20) out.push({ path, chunk: slice, start });
    start += CHUNK_SIZE - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }
  return out;
}

// ── File filtering ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".vite", "target",
  ".nikolai", ".nikolai_backups", "__pycache__", ".next", ".nuxt",
  "coverage", ".turbo", ".cache", ".output", "vendor", ".svelte-kit",
]);

const TEXT_EXTS = new Set([
  "ts","tsx","js","jsx","mjs","cjs",
  "rs","toml","lock",
  "json","jsonc",
  "md","txt","mdx","rst",
  "css","scss","less",
  "html","htm","svg",
  "py","rb","go","java","c","cpp","h","hpp","cs","swift","kt",
  "sh","bash","ps1","fish",
  "yml","yaml","env","env.example",
  "prisma","graphql","gql","sql",
  "vue","svelte",
]);

export function shouldIndexFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTS.has(ext);
}

// ── Ollama embedding call ─────────────────────────────────────────────────────

export async function embedText(
  text:    string,
  baseUrl: string,
  model =  "nomic-embed-text",
): Promise<number[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/embeddings`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ model, prompt: text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404 || body.toLowerCase().includes("not found") || body.toLowerCase().includes("pull")) {
      throw new Error(
        `Embedding model "${model}" not found in Ollama.\n` +
        `Run:  ollama pull ${model}\n(~274 MB, one-time download — then click Build Index again)`
      );
    }
    throw new Error(`Ollama /api/embeddings returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!Array.isArray(json.embedding)) {
    throw new Error(`Ollama response has no embedding field — is Ollama up to date?`);
  }
  return json.embedding as number[];
}

// ── Index builder ─────────────────────────────────────────────────────────────

export type BuildProgress = {
  phase:   "listing" | "reading" | "embedding" | "done" | "error";
  current: number;
  total:   number;
  file:    string;
  message: string;
};

export type BuildOptions = {
  root:        string;
  baseUrl:     string;
  model?:      string;
  maxFiles?:   number;     // default 120
  onProgress?: (p: BuildProgress) => void;
  signal?:     AbortSignal;
  // Provided by WorkspacePanel — reuses existing Tauri commands
  listDir:     (rel: string) => Promise<Array<{ name: string; is_dir: boolean; rel: string }>>;
  readFile:    (rel: string) => Promise<string>;
};

async function collectIndexableFiles(
  listDir:   BuildOptions["listDir"],
  rel:       string,
  depth:     number,
  out:       string[],
  maxFiles:  number,
): Promise<void> {
  if (depth > 6 || out.length >= maxFiles) return;
  try {
    const entries = await listDir(rel || ".");
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const full = rel ? `${rel}/${e.name}` : e.name;
      if (e.is_dir) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) {
          await collectIndexableFiles(listDir, full, depth + 1, out, maxFiles);
        }
      } else if (shouldIndexFile(e.name)) {
        out.push(full);
      }
    }
  } catch { /* unreadable directory — skip silently */ }
}

export async function buildIndex(opts: BuildOptions): Promise<SemanticIndex> {
  const model    = opts.model    ?? "nomic-embed-text";
  const maxFiles = opts.maxFiles ?? 120;

  // ── Phase 1: collect files ──────────────────────────────────────────────
  opts.onProgress?.({ phase: "listing", current: 0, total: 0, file: "", message: "Scanning workspace…" });
  const files: string[] = [];
  await collectIndexableFiles(opts.listDir, "", 0, files, maxFiles);
  if (files.length === 0) throw new Error("No indexable files found. Check workspace root is set.");

  // ── Phase 2: read + chunk ───────────────────────────────────────────────
  opts.onProgress?.({ phase: "reading", current: 0, total: files.length, file: "", message: `Reading ${files.length} files…` });
  const rawChunks: Array<{ path: string; chunk: string; start: number }> = [];

  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) throw new Error("Aborted by user");
    const rel = files[i];
    opts.onProgress?.({ phase: "reading", current: i + 1, total: files.length, file: rel, message: `Reading ${rel}` });
    try {
      const text = await opts.readFile(rel);
      if (text?.length > 10) rawChunks.push(...chunkFile(rel, text.slice(0, 20_000)));
    } catch { /* file unreadable — skip */ }
  }

  if (rawChunks.length === 0) throw new Error("All files were empty or unreadable.");

  // ── Phase 3: embed ──────────────────────────────────────────────────────
  const indexChunks: IndexChunk[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    if (opts.signal?.aborted) throw new Error("Aborted by user");
    const { path, chunk, start } = rawChunks[i];
    opts.onProgress?.({
      phase:   "embedding",
      current: i + 1,
      total:   rawChunks.length,
      file:    path,
      message: `Embedding ${i + 1}/${rawChunks.length}  —  ${path}`,
    });
    try {
      const embedding = await embedText(chunk, opts.baseUrl, model);
      indexChunks.push({ path, chunk, start, embedding });
    } catch (e: any) {
      if ((e?.message ?? "").includes("ollama pull")) throw e; // model not found → stop immediately
      // network blip or single chunk failure → skip and continue
    }
  }

  opts.onProgress?.({
    phase:   "done",
    current: indexChunks.length,
    total:   indexChunks.length,
    file:    "",
    message: `✓ Index built — ${indexChunks.length} chunks from ${files.length} files`,
  });

  return { root: opts.root, model, built_at: Date.now(), chunks: indexChunks, file_count: files.length };
}

// ── Search ────────────────────────────────────────────────────────────────────

export type SearchResult = {
  path:  string;
  chunk: string;
  score: number;   // 0–1 cosine similarity
  start: number;
};

export async function searchIndex(
  query:   string,
  baseUrl: string,
  index:   SemanticIndex,
  topK =   5,
): Promise<SearchResult[]> {
  if (!index?.chunks?.length) return [];
  const qVec = await embedText(query, baseUrl, index.model);

  const scored = index.chunks.map((c) => ({
    path:  c.path,
    chunk: c.chunk,
    start: c.start,
    score: cosine(qVec, c.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Best chunk per file — avoid sending 5 chunks from the same file
  const seen = new Set<string>();
  const out:  SearchResult[] = [];
  for (const r of scored) {
    if (out.length >= topK) break;
    if (!seen.has(r.path)) { seen.add(r.path); out.push(r); }
  }
  return out;
}

export function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return "No relevant files found in the semantic index.";
  return results
    .map((r, i) => `[${i + 1}] ${r.path}  (${Math.round(r.score * 100)}% match)\n\`\`\`\n${r.chunk.trim()}\n\`\`\``)
    .join("\n\n");
}