// ── Atelier NikolAi Desktop — Session Memory ─────────────────────────────────
//
// Persists facts per workspace root across chats (localStorage).
// Each workspace root gets its own isolated store.
// The agent reads this at the start of every agentic call so it
// remembers context without needing to re-explore the project.
//
// V4-C: Memory is manually managed (add/delete in UI).
// V5 target: auto-extract facts from agent answers.

export type MemoryFact = {
  id: string;
  text: string;
  ts: number;
  source: "user" | "agent";
};

function memKey(root: string): string {
  // Sanitise root path to a safe localStorage key
  const safe = root.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `nikolai.memory.v1.${safe}`;
}

export function loadMemory(root: string): MemoryFact[] {
  if (!root) return [];
  try {
    const raw = localStorage.getItem(memKey(root));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveMemory(root: string, facts: MemoryFact[]): void {
  if (!root) return;
  try {
    localStorage.setItem(memKey(root), JSON.stringify(facts.slice(0, 200)));
  } catch {}
}

export function addFact(
  root: string,
  text: string,
  source: MemoryFact["source"] = "user"
): MemoryFact {
  if (!root || !text.trim()) throw new Error("Root and text required");

  const facts = loadMemory(root);
  const fact: MemoryFact = {
    id: `mem-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    text: text.trim(),
    ts: Date.now(),
    source,
  };
  facts.unshift(fact);
  saveMemory(root, facts);
  return fact;
}

export function deleteFact(root: string, id: string): void {
  const facts = loadMemory(root).filter((f) => f.id !== id);
  saveMemory(root, facts);
}

export function clearMemory(root: string): void {
  if (!root) return;
  try { localStorage.removeItem(memKey(root)); } catch {}
}

/** Format memory for injection into planner system prompt. */
export function formatMemoryForPrompt(facts: MemoryFact[]): string {
  if (facts.length === 0) return "";
  return facts
    .slice(0, 30)
    .map((f) => `• ${f.text}`)
    .join("\n");
}