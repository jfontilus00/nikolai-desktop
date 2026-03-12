import { TurnPhase, AgentEvent } from "./types";
import { MicSTT } from "./micSTT";
import { StreamTTS } from "./streamTTS";
import { InterruptController } from "./interruptController";
import { TurnStateMachine } from "./turnStateMachine";

export interface ConversationLoopOptions {
  onPhaseChange: (phase: TurnPhase) => void;
  onTranscript: (text: string, final: boolean) => void;
  onAgentToken: (token: string) => void;
  onError: (err: Error) => void;
  runAgent: (msg: string) => AsyncGenerator<AgentEvent>;
}

export class ConversationLoop {
  private phase: TurnPhase = "idle";
  private stt: MicSTT | null = null;
  private silenceTimer: any = null;
  private tts = new StreamTTS();
  private accumulated = "";
  private interrupt = new InterruptController();
  private turn = new TurnStateMachine();

  constructor(private opts: ConversationLoopOptions) {}

  private setPhase(p: TurnPhase) {
    if (this.phase !== p) {
      this.phase = p;
      this.opts.onPhaseChange(p);
      this.turn.set(p as any);
    }
  }

  startListening() {
    this.setPhase("listening");

    this.stt = new MicSTT({
      onInterim: (text) => {
        this.opts.onTranscript(text, false);
        this.resetSilenceTimer();
      },

      onFinal: (text) => {
        this.opts.onTranscript(text, true);
        this.resetSilenceTimer(text);
      },

      onError: (err) => {
        this.opts.onError(err);
      },
    });

    this.stt.start();
  }

  private resetSilenceTimer(finalText?: string) {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }

    this.silenceTimer = setTimeout(() => {
      if (finalText && finalText.trim()) {
        this.injectUserMessage(finalText);
      }
    }, 1200);
  }

  async injectUserMessage(text: string) {
    if (!text.trim()) return;

    this.setPhase("agent_thinking");

    // natural voice filler for longer responses
    const fillers = [
      "Let me check that.",
      "One moment.",
      "Looking into that.",
      "Alright, let's see.",
    ];

    if (Math.random() > 0.5) {
      const f = fillers[Math.floor(Math.random() * fillers.length)];
      this.tts.feed(f);
    }

    const signal = this.interrupt.start();

    try {
      const stream = this.opts.runAgent(text);

      for await (const ev of stream) {
        if (signal.aborted) {
          this.setPhase("interrupted");
          return;
        }

        if (ev.type === "token") {
          this.opts.onAgentToken(ev.text);

          // accumulate tokens for sentence streaming
          this.accumulated += ev.text;

          const sentences = this.accumulated.split(/(?<=[.!?])\s+/);

          if (sentences.length > 1) {
            const speak = sentences.slice(0, -1).join(" ");
            this.accumulated = sentences[sentences.length - 1];
            this.setPhase("agent_speaking");
            this.tts.feed(speak);
          }
        }

        if (ev.type === "final") {
          if (this.accumulated.trim()) {
            this.tts.feed(this.accumulated);
            this.accumulated = "";
          }

          this.setPhase("listening");
        }

        if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    } catch (err) {
      this.opts.onError(err as Error);
      this.setPhase("idle");
    }
  }

  getPhase() {
    return this.phase;
  }

  /**
   * Called when user interrupts speech
   */
  public handleBargeIn() {
    this.interrupt.cancel();
    this.tts.stop();
    this.accumulated = "";
    this.setPhase("interrupted");

    setTimeout(() => {
      this.setPhase("listening");
    }, 200);
  }
}
