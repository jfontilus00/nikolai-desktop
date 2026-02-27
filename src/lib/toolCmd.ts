// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolCommand =
  | { ok: true;  name: string; args: any; rawArgs?: string }
  | { ok: false; error: string };                            // parse failure — surface to user

// ── JSON repair for Windows paths ─────────────────────────────────────────────

function tryParseJsonLoose(jsonPart: string): { ok: true; value: any } | { ok: false; error: string } {
  // 1) Strict parse first
  try {
    return { ok: true, value: JSON.parse(jsonPart) };
  } catch {
    // continue to recovery
  }

  // 2) Repair Windows paths typed without escaping:
  //    "C:\Dev\foo" → "C:/Dev/foo"
  //    Only rewrites inside quoted strings to avoid corrupting other content.
  const repaired = jsonPart.replace(/"([A-Za-z]):\\([^"]*)"/g, (_m, drive, rest) => {
    const normalized = String(rest).replace(/\\/g, "/");
    return `"${drive}:/${normalized}"`;
  });

  if (repaired !== jsonPart) {
    try {
      return { ok: true, value: JSON.parse(repaired) };
    } catch {
      // fallthrough
    }
  }

  // 3) Helpful error for the user
  return {
    ok: false,
    error: [
      "Could not parse tool arguments as JSON.",
      "",
      "Usage:   /tool <name> {\"key\": \"value\"}",
      "Example: /tool fs.read_file {\"path\": \"src/App.tsx\"}",
      "",
      "Windows path tip: use forward slashes or escape backslashes:",
      '  ✓  {"path": "C:/Dev/project/file.ts"}',
      '  ✓  {"path": "C:\\\\Dev\\\\project\\\\file.ts"}',
      '  ✗  {"path": "C:\\Dev\\project\\file.ts"}   ← breaks JSON',
    ].join("\n"),
  };
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parses a /tool command from chat input.
 *
 * Returns:
 *   { ok: true,  name, args, rawArgs } — valid command, ready to execute
 *   { ok: false, error }               — parse failure, show error to user
 *   null                               — input is not a /tool command at all
 */
export function parseToolCommand(input: string): ToolCommand | null {
  const t = (input || "").trim();
  if (!t.toLowerCase().startsWith("/tool ")) return null;

  const rest = t.slice(6).trim(); // "/tool " is 6 chars
  if (!rest) return null;

  const firstSpace = rest.indexOf(" ");

  // No args provided — treat as empty object, not an error
  if (firstSpace === -1) {
    return { ok: true, name: rest.trim(), args: {}, rawArgs: "" };
  }

  const name = rest.slice(0, firstSpace).trim();
  if (!name) return null;

  const jsonPart = rest.slice(firstSpace + 1).trim();
  if (!jsonPart) {
    return { ok: true, name, args: {}, rawArgs: "" };
  }

  const parsed = tryParseJsonLoose(jsonPart);

  if (parsed.ok) {
    return { ok: true, name, args: parsed.value, rawArgs: jsonPart };
  }

  // ✅ FIXED: return a typed error instead of passing { __parse_error__: "..." }
  // as actual tool args. Previously this caused mcpCallTool to be called with
  // garbage args, producing confusing backend errors instead of a clear user message.
  return { ok: false, error: parsed.error };
}