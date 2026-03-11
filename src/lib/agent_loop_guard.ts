// ── Agent Loop Guard ────────────────────────────────────────────────────────
//
// Detects repeated tool patterns that indicate the agent is stuck
// in an infinite reasoning loop. Terminates execution safely.
//
// This is a safety mechanism only.
// Does NOT modify agent logic, planning, or tool execution.
//

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoopGuardState {
  recentTools: string[];
  recentArgsHashes: string[];
  maxHistory: number;
}

export type LoopDetectionResult = {
  loopDetected: boolean;
  reason: string;
};

// ── Loop Guard Creation ──────────────────────────────────────────────────────

/**
 * Creates a new loop guard state.
 */
export function createLoopGuard(): LoopGuardState {
  return {
    recentTools: [],
    recentArgsHashes: [],
    maxHistory: 6,  // Track last 6 tool calls
  };
}

// ── Argument Hashing ─────────────────────────────────────────────────────────

/**
 * Creates a deterministic hash of tool arguments.
 * Used to detect repeated tool calls with same arguments.
 */
export function hashArgs(args: any): string {
  try {
    // Sort keys for consistent hashing
    const sorted = JSON.stringify(args, Object.keys(args).sort());
    return sorted;
  } catch {
    // Fallback for non-serializable args
    return String(args);
  }
}

// ── Record Tool Usage ────────────────────────────────────────────────────────

/**
 * Records a tool call in the loop guard state.
 */
export function recordTool(
  guard: LoopGuardState,
  toolName: string,
  args: any
): void {
  // Store tool name
  guard.recentTools.push(toolName);
  
  // Store argument hash
  guard.recentArgsHashes.push(hashArgs(args));
  
  // Trim to maxHistory
  while (guard.recentTools.length > guard.maxHistory) {
    guard.recentTools.shift();
    guard.recentArgsHashes.shift();
  }
}

// ── Loop Detection ───────────────────────────────────────────────────────────

/**
 * Detects loop patterns in recent tool calls.
 * Returns true if a suspicious pattern is detected.
 */
export function detectLoop(guard: LoopGuardState): LoopDetectionResult {
  const tools = guard.recentTools;
  const hashes = guard.recentArgsHashes;
  
  // Need at least 3 calls to detect a pattern
  if (tools.length < 3) {
    return { loopDetected: false, reason: "" };
  }
  
  // ── CASE 1: Same tool repeated 4 times ────────────────────────────────────
  // Example: read_file → read_file → read_file → read_file
  if (tools.length >= 4) {
    const last4 = tools.slice(-4);
    const allSame = last4.every((t) => t === last4[0]);
    
    if (allSame) {
      return {
        loopDetected: true,
        reason: `Same tool "${last4[0]}" executed 4 times consecutively`,
      };
    }
  }
  
  // ── CASE 2: Same tool + same args repeated 3 times ────────────────────────
  // Example: read_file("README.md") repeated 3 times
  if (tools.length >= 3) {
    for (let i = tools.length - 3; i >= 0; i--) {
      const tool1 = tools[i];
      const tool2 = tools[i + 1];
      const tool3 = tools[i + 2];
      
      const hash1 = hashes[i];
      const hash2 = hashes[i + 1];
      const hash3 = hashes[i + 2];
      
      if (tool1 === tool2 && tool2 === tool3 && hash1 === hash2 && hash2 === hash3) {
        return {
          loopDetected: true,
          reason: `Same tool "${tool1}" with identical arguments executed 3 times`,
        };
      }
    }
  }
  
  // ── CASE 3: Alternating tool loop ─────────────────────────────────────────
  // Example: search_files → read_file → search_files → read_file → search_files → read_file
  if (tools.length >= 6) {
    const last6 = tools.slice(-6);
    const last6Hashes = hashes.slice(-6);
    
    // Check for A-B-A-B-A-B pattern
    const toolA = last6[0];
    const toolB = last6[1];
    
    if (toolA !== toolB) {
      const isAlternating = 
        last6[0] === toolA && last6[1] === toolB &&
        last6[2] === toolA && last6[3] === toolB &&
        last6[4] === toolA && last6[5] === toolB;
      
      // Also check if args are repeating (stronger signal)
      const argsAlternating =
        last6Hashes[0] === last6Hashes[2] && last6Hashes[2] === last6Hashes[4] &&
        last6Hashes[1] === last6Hashes[3] && last6Hashes[3] === last6Hashes[5];
      
      if (isAlternating && argsAlternating) {
        return {
          loopDetected: true,
          reason: `Alternating pattern detected: ${toolA} ↔ ${toolB} (3 cycles)`,
        };
      }
    }
  }
  
  // ── CASE 4: 3-tool cycle ─────────────────────────────────────────────────
  // Example: A → B → C → A → B → C
  if (tools.length >= 6) {
    const last6 = tools.slice(-6);
    
    const toolA = last6[0];
    const toolB = last6[1];
    const toolC = last6[2];
    
    // All three must be different
    if (toolA !== toolB && toolB !== toolC && toolA !== toolC) {
      const is3Cycle =
        last6[0] === toolA && last6[1] === toolB && last6[2] === toolC &&
        last6[3] === toolA && last6[4] === toolB && last6[5] === toolC;
      
      if (is3Cycle) {
        return {
          loopDetected: true,
          reason: `3-tool cycle detected: ${toolA} → ${toolB} → ${toolC} (2 cycles)`,
        };
      }
    }
  }
  
  // No loop detected
  return { loopDetected: false, reason: "" };
}

/**
 * Gets loop guard statistics for debugging.
 */
export function getLoopGuardStats(guard: LoopGuardState): {
  toolCount: number;
  recentTools: string[];
  maxHistory: number;
} {
  return {
    toolCount: guard.recentTools.length,
    recentTools: [...guard.recentTools],
    maxHistory: guard.maxHistory,
  };
}
