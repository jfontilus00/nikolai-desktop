export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_done"; name: string; result: unknown }
  | { type: "final"; fullText: string }
  | { type: "error"; message: string };

export type TurnPhase =
  | "idle"
  | "listening"
  | "user_speaking"
  | "processing"
  | "agent_thinking"
  | "agent_speaking"
  | "interrupted";
