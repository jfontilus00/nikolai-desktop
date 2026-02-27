import React, { useEffect, useRef, useState } from "react";
import type { LayoutState } from "../types";
import { loadLayout, saveLayout } from "../lib/storage";

type Props = {
  left: React.ReactNode;
  center: React.ReactNode;
  right: React.ReactNode;
  onToggleLeft?: (collapsed: boolean) => void;
  onToggleRight?: (collapsed: boolean) => void;
};

export default function ResizableShell({ left, center, right, onToggleLeft, onToggleRight }: Props) {
  const [layout, setLayout] = useState<LayoutState>(() => loadLayout());
  const dragRef = useRef<{ side: "left" | "right" | null; startX: number; startW: number } | null>(null);

  useEffect(() => { const id = window.setTimeout(() => saveLayout(layout), 150); return () => window.clearTimeout(id); }, [layout]);

  const leftW = layout.leftCollapsed ? 56 : layout.leftWidth;
  const rightW = layout.rightCollapsed ? 56 : layout.rightWidth;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const beginDrag = (side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { side, startX: e.clientX, startW: side === "left" ? layout.leftWidth : layout.rightWidth };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onMove = (e: MouseEvent) => {
    const d = dragRef.current;
    if (!d?.side) return;
    const dx = e.clientX - d.startX;

    setLayout((prev) => {
      if (d.side === "left") return { ...prev, leftWidth: clamp(d.startW + dx, 220, 480) };
      return { ...prev, rightWidth: clamp(d.startW - dx, 260, 520) };
    });
  };

  const onUp = () => {
    dragRef.current = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  const toggleLeft = () =>
    setLayout((p) => {
      const next = { ...p, leftCollapsed: !p.leftCollapsed };
      onToggleLeft?.(next.leftCollapsed);
      return next;
    });

  const toggleRight = () =>
    setLayout((p) => {
      const next = { ...p, rightCollapsed: !p.rightCollapsed };
      onToggleRight?.(next.rightCollapsed);
      return next;
    });

  const railBtn =
    "px-2 py-1 rounded-md text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10";

  return (
    <div className="h-full w-full bg-zinc-950 text-zinc-100">
      <div className="h-full w-full flex overflow-hidden">
        <div style={{ width: leftW }} className="h-full border-r border-white/10 bg-zinc-950">
          <div className="h-12 flex items-center justify-between px-2 border-b border-white/10">
            <div className="text-xs font-bold tracking-wide opacity-80">{layout.leftCollapsed ? "N" : "Nikolai"}</div>
            <button className={railBtn} onClick={toggleLeft} title="Collapse/Expand">
              {layout.leftCollapsed ? "»" : "«"}
            </button>
          </div>
          <div className="h-[calc(100%-3rem)]">{left}</div>
        </div>

        <div className="w-1 cursor-col-resize bg-white/0 hover:bg-white/10" onMouseDown={beginDrag("left")} />

        <div className="flex-1 h-full bg-zinc-950">{center}</div>

        <div className="w-1 cursor-col-resize bg-white/0 hover:bg-white/10" onMouseDown={beginDrag("right")} />

        <div style={{ width: rightW }} className="h-full border-l border-white/10 bg-zinc-950">
          <div className="h-12 flex items-center justify-between px-2 border-b border-white/10">
            <div className="text-xs font-bold tracking-wide opacity-80">{layout.rightCollapsed ? "⚙" : "Settings"}</div>
            <button className={railBtn} onClick={toggleRight} title="Collapse/Expand">
              {layout.rightCollapsed ? "«" : "»"}
            </button>
          </div>
          <div className="h-[calc(100%-3rem)]">{right}</div>
        </div>
      </div>
    </div>
  );
}


