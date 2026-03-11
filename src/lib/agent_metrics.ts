// ── Agent Metrics Logging ────────────────────────────────────────────────────
//
// Provides runtime observability for debugging and performance tuning.
// Logs metrics to console only — NO persistent telemetry.
//
// This is an observability feature only.
// Does NOT modify agent logic or security behavior.
//

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentMetrics {
  runId: string;
  startTime: number;
  endTime?: number;
  stepsExecuted: number;
  toolsUsed: Record<string, number>;
  lowConfidenceTools: Array<{ name: string; confidence: number }>;  // Track low-confidence calls
  reasoningLengths: number[];  // Track reasoning lengths for quality analysis
  toolBudgetRemaining?: number;  // Track remaining tool budget at end of run
  tokensUsed?: number;  // Optional — requires token counting integration
  status: "running" | "completed" | "failed";
  error?: string;
}

// ── Metrics State ─────────────────────────────────────────────────────────────

let currentMetrics: AgentMetrics | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Starts metrics tracking for a new agent run.
 */
export function startAgentMetrics(runId: string): void {
  currentMetrics = {
    runId,
    startTime: Date.now(),
    stepsExecuted: 0,
    toolsUsed: {},
    lowConfidenceTools: [],
    reasoningLengths: [],
    status: "running",
  };
}

/**
 * Records that a tool was used.
 */
export function recordToolUsage(toolName: string): void {
  if (!currentMetrics) return;
  
  const existing = currentMetrics.toolsUsed[toolName] || 0;
  currentMetrics.toolsUsed[toolName] = existing + 1;
}

/**
 * Increments the step counter.
 */
export function incrementStep(): void {
  if (!currentMetrics) return;
  currentMetrics.stepsExecuted++;
}

/**
 * Records an error for the current run.
 */
export function recordError(error: string): void {
  if (!currentMetrics) return;
  currentMetrics.error = error;
  currentMetrics.status = "failed";
}

/**
 * Finishes metrics tracking and logs summary to console.
 */
export function finishAgentMetrics(): void {
  if (!currentMetrics) return;
  
  currentMetrics.endTime = Date.now();
  currentMetrics.status = currentMetrics.status === "running" ? "completed" : currentMetrics.status;
  
  // Log metrics to console
  logMetrics(currentMetrics);
  
  // Clear current metrics
  currentMetrics = null;
}

/**
 * Logs metrics in a human-readable format.
 */
function logMetrics(metrics: AgentMetrics): void {
  const duration = (metrics.endTime || Date.now()) - metrics.startTime;
  const durationSec = (duration / 1000).toFixed(2);
  
  const lines: string[] = [
    "",
    "Agent Run Metrics",
    "=================",
    `Run ID: ${metrics.runId}`,
    `Status: ${metrics.status}`,
    `Steps executed: ${metrics.stepsExecuted}`,
    `Duration: ${durationSec}s`,
  ];
  
  // Tools used
  const toolNames = Object.keys(metrics.toolsUsed);
  if (toolNames.length > 0) {
    lines.push("");
    lines.push("Tools used:");
    
    // Sort by usage count (descending)
    const sorted = toolNames.sort((a, b) => metrics.toolsUsed[b] - metrics.toolsUsed[a]);
    
    for (const tool of sorted) {
      const count = metrics.toolsUsed[tool];
      const bareName = tool.split(".").pop() || tool;
      lines.push(`  ${bareName}: ${count}`);
    }
  }
  
  // Error if any
  if (metrics.error) {
    lines.push("");
    lines.push(`Error: ${metrics.error}`);
  }
  
  // Token estimate (if available)
  if (metrics.tokensUsed) {
    lines.push("");
    lines.push(`Estimated tokens: ${metrics.tokensUsed.toLocaleString()}`);
  }

  // Low-confidence tools (if any)
  if (metrics.lowConfidenceTools.length > 0) {
    lines.push("");
    lines.push(`Low-confidence tools: ${metrics.lowConfidenceTools.length}`);
    for (const t of metrics.lowConfidenceTools.slice(0, 5)) {
      lines.push(`  • ${t.name} (${t.confidence.toFixed(2)})`);
    }
  }

  lines.push("");

  console.log(lines.join("\n"));
}

/**
 * Records a tool call with low confidence.
 */
export function recordLowConfidenceTool(toolName: string, confidence: number): void {
  if (!currentMetrics) return;
  currentMetrics.lowConfidenceTools.push({ name: toolName, confidence });
}

/**
 * Records the length of reasoning text for a tool call.
 */
export function recordReasoningLength(length: number): void {
  if (!currentMetrics) return;
  currentMetrics.reasoningLengths.push(length);
}

/**
 * Records the remaining tool budget at end of run.
 */
export function recordToolBudgetRemaining(remaining: number): void {
  if (!currentMetrics) return;
  currentMetrics.toolBudgetRemaining = remaining;
}

/**
 * Gets current metrics (for debugging/inspection).
 */
export function getCurrentMetrics(): AgentMetrics | null {
  return currentMetrics;
}

/**
 * Formats metrics as string (for UI display).
 */
export function formatMetrics(metrics: AgentMetrics): string {
  const duration = (metrics.endTime || Date.now()) - metrics.startTime;
  const durationSec = (duration / 1000).toFixed(2);
  
  const lines: string[] = [
    `Run: ${metrics.runId}`,
    `Status: ${metrics.status}`,
    `Steps: ${metrics.stepsExecuted}`,
    `Duration: ${durationSec}s`,
  ];
  
  const toolCount = Object.keys(metrics.toolsUsed).length;
  if (toolCount > 0) {
    lines.push(`Tools: ${toolCount}`);
  }
  
  return lines.join(" | ");
}
