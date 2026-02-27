export type FormattedToolResult = {
  text: string;
  isError: boolean;
};

const READ_FILE_PREVIEW_LINES = 200;

function safeStringify(v: any): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatDirectoryListing(arr: any[]): string | null {
  if (!Array.isArray(arr)) return null;
  if (arr.length === 0) return "";
  const okShape = arr.every(
    (x) => x && typeof x === "object" && typeof x.name === "string" && typeof x.type === "string"
  );
  if (!okShape) return null;

  return arr
    .map((x) => {
      const tag = x.type === "directory" ? "[dir]" : "[file]";
      return `- ${tag} ${x.name}`;
    })
    .join("\n");
}

function parseJsonText(text: string): any | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // try unescape
    }
  } else {
    return null;
  }

  const candidate = trimmed.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  if (candidate !== trimmed) {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeText(raw: string): string {
  if (raw.includes("\\n") && !raw.includes("\n")) {
    return raw.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return raw;
}

function previewByLines(text: string, maxLines: number): { preview: string; totalLines: number; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  if (totalLines <= maxLines) {
    return { preview: text, totalLines, truncated: false };
  }
  const preview = lines.slice(0, maxLines).join("\n");
  return { preview, totalLines, truncated: true };
}

function looksLikeFileContents(s: string): boolean {
  // heuristics: if it has many newlines or looks like JSON/YAML/code
  const lines = s.split(/\r?\n/).length;
  if (lines >= 30) return true;
  if (s.includes("{\n") || s.includes("}\n") || s.includes(":\n") || s.includes("function ") || s.includes("import ")) return true;
  return false;
}

export function formatToolResult(toolName: string, out: any): FormattedToolResult {
  const isError = !!(out && typeof out === "object" && out.isError);

  // Extract MCP-style content[].text if present
  let textParts: string[] = [];
  if (out && typeof out === "object" && Array.isArray(out.content)) {
    for (const item of out.content) {
      if (!item) continue;
      if (typeof item.text === "string") textParts.push(item.text);
      else textParts.push(safeStringify(item));
    }
  } else if (typeof out === "string") {
    textParts.push(out);
  } else {
    textParts.push(safeStringify(out));
  }

  let text = normalizeText(textParts.join("\n").trim());

  // If it looks like JSON, parse and format (directory listing etc.)
  const parsed = parseJsonText(text);
  if (parsed != null) {
    const listFmt = Array.isArray(parsed) ? formatDirectoryListing(parsed) : null;
    if (listFmt != null) {
      text = listFmt;
    } else {
      text = safeStringify(parsed);
    }
  }

  // Preview large read_file outputs (Claude/Qwen Desktop style)
  const isReadFile = toolName === "fs.read_file" || toolName.endsWith(".read_file");
  if (isReadFile || looksLikeFileContents(text)) {
    const { preview, totalLines, truncated } = previewByLines(text, READ_FILE_PREVIEW_LINES);
    if (truncated) {
      text =
        `${preview}\n\n` +
        `… truncated (${READ_FILE_PREVIEW_LINES}/${totalLines} lines shown)\n` +
        `Tip: use fs.search_files to find keywords, or re-run fs.read_file on a smaller file.`;
    } else {
      text = preview;
    }
  }

  // Avoid giant chat bubbles regardless
  const MAX = 80000;
  if (text.length > MAX) {
    text = text.slice(0, MAX) + `\n\n…(truncated at ${MAX} chars)`;
  }

  if (!text) text = safeStringify(out);
  return { text, isError };
}
