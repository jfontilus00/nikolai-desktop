// ── LLM Request Queue ────────────────────────────────────────────────────────
//
// Prevents concurrent LLM requests from overwhelming VRAM.
// Queues requests and processes them sequentially.
//

export class LLMQueue {
  private running = 0;
  private queue: (() => void)[] = [];
  private maxConcurrent = 1;

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.running++;

    try {
      const result = await task();
      return result;
    } finally {
      this.running--;

      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export const llmQueue = new LLMQueue(1);
