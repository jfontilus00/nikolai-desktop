/**
 * Interrupt Controller
 *
 * Allows cancelling:
 * - active TTS
 * - running agent streams
 */

export class InterruptController {
  private abort: AbortController | null = null;

  start() {
    this.abort = new AbortController();
    return this.abort.signal;
  }

  cancel() {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
  }
}
