import { useMemo, useState, useEffect } from "react";
import type { ChatThread } from "../types";

type Props = {
  collapsed: boolean;
  chats: ChatThread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
};

// ── Date grouping ─────────────────────────────────────────────────────────────

const GROUP_ORDER = ["Today", "Yesterday", "This week", "This month", "Older"] as const;
type Group = typeof GROUP_ORDER[number];

function dateGroup(ts: number): Group {
  const now   = new Date();
  const item  = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yest  = new Date(today); yest.setDate(today.getDate() - 1);
  const week  = new Date(today); week.setDate(today.getDate() - 7);
  const month = new Date(today); month.setDate(today.getDate() - 30);

  const d = new Date(item.getFullYear(), item.getMonth(), item.getDate());

  if (d >= today)                return "Today";
  if (d >= yest)                 return "Yesterday";
  if (d >= week)                 return "This week";
  if (d >= month)                return "This month";
  return "Older";
}

// ── Snippet helper ─────────────────────────────────────────────────────────────

function snippetFor(c: ChatThread, q: string): string {
  const s = q.trim().toLowerCase();
  if (!s) return "";
  if ((c.title || "").toLowerCase().includes(s)) return `Title: ${c.title}`;

  const msgs: any[] = (c as any).messages || [];
  for (const m of msgs) {
    const txt = String(m?.content || "");
    const idx = txt.toLowerCase().indexOf(s);
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end   = Math.min(txt.length, idx + s.length + 80);
      const chunk = txt.slice(start, end).replace(/\s+/g, " ").trim();
      return chunk.length < txt.length ? `… ${chunk} …` : chunk;
    }
  }
  return "";
}

export default function ChatHistory({
  collapsed,
  chats,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: Props) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  // Debounce search input by 250ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(timer);
  }, [q]);

  // When searching: flat list with snippets
  // When not searching: grouped by date
  const filtered = useMemo(() => {
    const s = debouncedQ.trim().toLowerCase();
    if (!s) return chats;
    return chats.filter(
      (c) =>
        (c.title || "").toLowerCase().includes(s) ||
        (c.messages || []).some((m) => (m.content || "").toLowerCase().includes(s))
    );
  }, [debouncedQ, chats]);

  const grouped = useMemo((): Array<{ label: Group; items: ChatThread[] }> => {
    if (q.trim()) return []; // don't group during search

    const map = new Map<Group, ChatThread[]>();
    for (const g of GROUP_ORDER) map.set(g, []);
    for (const c of chats) {
      const g = dateGroup(c.updatedAt);
      map.get(g)!.push(c);
    }
    return GROUP_ORDER
      .map((g) => ({ label: g, items: map.get(g)! }))
      .filter((g) => g.items.length > 0);
  }, [q, chats]);

  // ── Collapsed sidebar ──────────────────────────────────────────────────────

  if (collapsed) {
    return (
      <div className="h-full p-2 space-y-2">
        <button
          type="button"
          className="w-full rounded-md bg-white/5 hover:bg-white/10 border border-white/10 py-2 text-xs font-semibold"
          onClick={onCreate}
          title="New chat"
        >
          +
        </button>
        <div className="space-y-2 overflow-auto h-[calc(100%-3rem)] pr-1">
          {chats.slice(0, 40).map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`w-full rounded-md px-2 py-2 text-xs border ${
                c.id === activeId
                  ? "bg-white/10 border-white/20"
                  : "bg-white/5 hover:bg-white/10 border-white/10"
              }`}
              title={c.title}
            >
              {c.title.slice(0, 1).toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Chat row ───────────────────────────────────────────────────────────────

  const ChatRow = ({ c, snippet }: { c: ChatThread; snippet?: string }) => (
    <div
      className={`rounded-md border ${
        c.id === activeId
          ? "border-white/25 bg-white/10"
          : "border-white/10 bg-white/5 hover:bg-white/10"
      }`}
    >
      <button
        type="button"
        className="w-full text-left px-3 py-2"
        onClick={() => onSelect(c.id)}
      >
        <div className="text-sm font-semibold leading-snug truncate">{c.title}</div>
        <div className="text-xs opacity-50 mt-0.5">
          {new Date(c.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          {" · "}
          {(c.messages || []).length} msg
        </div>
        {snippet && (
          <div className="text-xs opacity-60 mt-1 leading-snug line-clamp-2">{snippet}</div>
        )}
      </button>
      <div className="flex items-center justify-between px-3 pb-2">
        <button
          type="button"
          className="text-xs opacity-60 hover:opacity-100"
          onClick={() => {
            const t = prompt("Rename chat", c.title);
            if (t && t.trim()) onRename(c.id, t.trim());
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="text-xs text-red-400/70 hover:text-red-300"
          onClick={() => onDelete(c.id)}
        >
          Delete
        </button>
      </div>
    </div>
  );

  // ── Expanded sidebar ───────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col p-3 gap-2">
      {/* Atelier NikolAi wordmark */}
      <div className="px-1 pb-1 border-b border-white/8 flex items-center justify-between">
        <div className="text-[10px] font-medium tracking-[0.18em] text-white/35 select-none uppercase">
          Atelier Nikol<span className="text-white/55">A</span>i
        </div>
        <div className="text-[9px] text-white/20 tracking-widest select-none">DESKTOP</div>
      </div>

      {/* Search + new */}
      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search chats…"
          className="flex-1 rounded-md bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
        />
        <button
          type="button"
          onClick={onCreate}
          className="rounded-md bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-2 text-sm font-semibold"
          title="New chat"
        >
          New
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto pr-1 space-y-1">
        {/* ── Search results: flat list with snippets ── */}
        {q.trim() && (
          <>
            {filtered.length === 0 && (
              <div className="text-xs opacity-50 mt-6 text-center">No results</div>
            )}
            {filtered.map((c) => (
              <ChatRow key={c.id} c={c} snippet={snippetFor(c, q)} />
            ))}
          </>
        )}

        {/* ── No search: grouped by date ── */}
        {!q.trim() && (
          <>
            {chats.length === 0 && (
              <div className="text-xs opacity-50 mt-6 text-center">No chats yet</div>
            )}
            {grouped.map(({ label, items }) => (
              <div key={label}>
                {/* Section header */}
                <div className="px-1 py-1.5 text-[10px] font-semibold uppercase tracking-widest opacity-40 select-none">
                  {label}
                </div>
                <div className="space-y-1">
                  {items.map((c) => (
                    <ChatRow key={c.id} c={c} />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}