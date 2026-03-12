/**
 * Streaming TTS helper
 *
 * Speaks sentences as soon as they are completed while the LLM
 * is still generating tokens.
 */

export class StreamTTS {
  private queue: string[] = [];
  private speaking = false;
  private synth = window.speechSynthesis;
  private buffer = "";
  private lastSpeakTime = 0;

  feed(text: string) {
    this.buffer += " " + text;

    const segments = this.detectSpeakableSegments(this.buffer);

    if (segments.length > 0) {
      for (const s of segments) {
        this.queue.push(this.clean(s));
      }

      this.buffer = "";

      this.drain();
    }
  }

  /**
   * Detect segments that are stable enough to speak
   * even if punctuation has not appeared yet.
   */
  private detectSpeakableSegments(text: string): string[] {
    const segments: string[] = [];

    // punctuation boundary
    const punctuationSplit = text.split(/(?<=[.!?])\s+/);

    if (punctuationSplit.length > 1) {
      segments.push(punctuationSplit.slice(0, -1).join(" "));
      return segments;
    }

    // anticipation boundary
    const words = text.trim().split(/\s+/);

    if (words.length > 12) {
      const chunk = words.slice(0, 10).join(" ");
      segments.push(chunk);
      return segments;
    }

    return segments;
  }

  private drain() {
    if (this.speaking) return;

    const next = this.queue.shift();
    if (!next) return;

    const utt = new SpeechSynthesisUtterance(next);

    utt.rate = 1.05;

    utt.onstart = () => {
      this.speaking = true;
      this.lastSpeakTime = Date.now();
    };

    utt.onend = () => {
      this.speaking = false;
      const delay = Math.max(20, 120 - (Date.now() - this.lastSpeakTime));
      setTimeout(() => this.drain(), delay);
    };

    this.synth.speak(utt);
  }

  private clean(text: string) {
    return text
      .replace(/```[\s\S]*?```/g, "code block")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/\[(.+?)\]\(.+?\)/g, "$1")
      .replace(/\n+/g, " ")
      .trim();
  }

  stop() {
    this.synth.cancel();
    this.queue = [];
    this.speaking = false;
  }
}
