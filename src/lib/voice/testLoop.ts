import { ConversationLoop } from "./ConversationLoop";
import { runAgentAsEvents } from "./agentAdapter";

// Stub localStorage for Node environment
if (typeof globalThis.localStorage === "undefined") {
  const store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
  } as any;
}

/**
 * Phase 1.5 Voice Loop Simulator
 *
 * This test harness validates the voice architecture pipeline
 * without requiring microphone, STT, or TTS.
 *
 * Flow tested:
 *
 * ConversationLoop
 *
 * agentAdapter
 *
 * agenticStreamChat
 */

export async function runVoiceLoopTest(model: string) {
  const loop = new ConversationLoop({
    onPhaseChange: (p) => {
      console.log("[voice phase]", p);
    },

    onTranscript: () => {},

    onAgentToken: (token) => {
      process.stdout.write(token);
    },

    onError: (err) => {
      console.error("[voice error]", err);
    },

    runAgent: (msg) => runAgentAsEvents(msg, { model }),
  });

  console.log("\nVoice Loop Test Started\n");

  await loop.injectUserMessage(
    "Explain how the Nikolai agent architecture works."
  );

  console.log("\n\nVoice Loop Test Finished\n");
}
