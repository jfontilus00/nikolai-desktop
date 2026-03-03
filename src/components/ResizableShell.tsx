import React, { useCallback, useEffect, useRef, useState } from "react";
import type { LayoutState } from "../types";
import { loadLayout, saveLayout } from "../lib/storage";

type Props = {
  left: React.ReactNode;
  center: React.ReactNode;
  right: React.ReactNode;
  onToggleLeft?: (collapsed: boolean) => void;
  onToggleRight?: (collapsed: boolean) => void;
};

const LEFT_MIN  = 220;
const LEFT_MAX  = 480;
const RIGHT_MIN = 260;
const RIGHT_MAX = 520;
const CENTER_MIN = 320; // never let chat area collapse below this

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

// Given current window width and collapsed states, clamp panel widths so
// the center column always has at least CENTER_MIN pixels.
function clampToWindow(
  leftWidth: number,
  rightWidth: number,
  leftCollapsed: boolean,
  rightCollapsed: boolean,
): { leftWidth: number; rightWidth: number } {
  const winW = window.innerWidth;
  const lw = leftCollapsed ? 56 : leftWidth;
  const rw = rightCollapsed ? 56 : rightWidth;
  const centerAvail = winW - lw - rw - 2; // 2 = drag rails

  if (centerAvail >= CENTER_MIN) return { leftWidth, rightWidth };

  // Shrink panels proportionally until center fits
  const overflow = CENTER_MIN - centerAvail;
  const leftShare  = Math.ceil(overflow / 2);
  const rightShare = overflow - leftShare;
  return {
    leftWidth:  clamp(leftWidth  - (leftCollapsed  ? 0 : leftShare),  LEFT_MIN,  LEFT_MAX),
    rightWidth: clamp(rightWidth - (rightCollapsed ? 0 : rightShare), RIGHT_MIN, RIGHT_MAX),
  };
}

export default function ResizableShell({ left, center, right, onToggleLeft, onToggleRight }: Props) {
  const [layout, setLayout] = useState<LayoutState>(() => loadLayout());

  // Stable refs for drag state — avoids stale-closure issues across re-renders
  const dragRef  = useRef<{ side: "left" | "right"; startX: number; startW: number } | null>(null);
  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  // Persist with debounce
  useEffect(() => {
    const id = window.setTimeout(() => saveLayout(layout), 150);
    return () => window.clearTimeout(id);
  }, [layout]);

  // Clamp panels whenever window resizes to prevent center-column collapse
  useEffect(() => {
    function onResize() {
      setLayout((prev) => {
        const clamped = clampToWindow(prev.leftWidth, prev.rightWidth, prev.leftCollapsed, prev.rightCollapsed);
        if (clamped.leftWidth === prev.leftWidth && clamped.rightWidth === prev.rightWidth) return prev;
        return { ...prev, ...clamped };
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Stable handlers using refs — safe to add/remove across re-renders during drag
  const onMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    setLayout((prev) => {
      if (d.side === "left") {
        const leftWidth = clamp(d.startW + dx, LEFT_MIN, LEFT_MAX);
        const clamped = clampToWindow(leftWidth, prev.rightWidth, prev.leftCollapsed, prev.rightCollapsed);
        return { ...prev, ...clamped };
      } else {
        const rightWidth = clamp(d.startW - dx, RIGHT_MIN, RIGHT_MAX);
        const clamped = clampToWindow(prev.leftWidth, rightWidth, prev.leftCollapsed, prev.rightCollapsed);
        return { ...prev, ...clamped };
      }
    });
  }, []); // stable — reads dragRef and calls setLayout, both stable

  const onUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup",   onUp);
  }, [onMove]);

  // Clean up if component unmounts mid-drag (e.g. hot-reload)
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
  }, [onMove, onUp]);

  const beginDrag = (side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startW = side === "left" ? layoutRef.current.leftWidth : layoutRef.current.rightWidth;
    dragRef.current = { side, startX: e.clientX, startW };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
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

  const leftW  = layout.leftCollapsed  ? 56 : layout.leftWidth;
  const rightW = layout.rightCollapsed ? 56 : layout.rightWidth;

  const railBtn =
    "px-2 py-1 rounded-md text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10";

  return (
    <div className="h-full w-full bg-zinc-950 text-zinc-100">
      <div className="h-full w-full flex overflow-hidden">
        <div style={{ width: leftW, flexShrink: 0 }} className="h-full border-r border-white/10 bg-zinc-950">
          <div className="h-12 flex items-center justify-between px-2 border-b border-white/10">
            <div className="text-xs font-bold tracking-wide opacity-80">{layout.leftCollapsed ? "N" : "Nikolai"}</div>
            <button className={railBtn} onClick={toggleLeft} title="Collapse/Expand">
              {layout.leftCollapsed ? "»" : "«"}
            </button>
          </div>
          <div className="h-[calc(100%-3rem)]">{left}</div>
        </div>

        <div className="w-1 cursor-col-resize bg-white/0 hover:bg-white/10 flex-shrink-0" onMouseDown={beginDrag("left")} />

        <div className="flex-1 h-full bg-zinc-950 min-w-0">{center}</div>

        <div className="w-1 cursor-col-resize bg-white/0 hover:bg-white/10 flex-shrink-0" onMouseDown={beginDrag("right")} />

        <div style={{ width: rightW, flexShrink: 0 }} className="h-full border-l border-white/10 bg-zinc-950">
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