/**
 * Turn State Machine
 *
 * Centralizes all voice states so the UI can react consistently.
 */

export type VoiceTurnState =
  | "idle"
  | "listening"
  | "user_speaking"
  | "processing"
  | "agent_thinking"
  | "agent_speaking"
  | "interrupted";

type Listener = (state: VoiceTurnState) => void;

export class TurnStateMachine {
  private state: VoiceTurnState = "idle";
  private listeners: Listener[] = [];

  set(state: VoiceTurnState) {
    if (this.state === state) return;

    this.state = state;

    for (const l of this.listeners) {
      l(state);
    }
  }

  get() {
    return this.state;
  }

  subscribe(listener: Listener) {
    this.listeners.push(listener);
  }
}
