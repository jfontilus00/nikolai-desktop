/**
 * Microphone Speech Recognition helper
 *
 * Uses Web Speech API to capture user speech and emit transcripts.
 * Designed to integrate with ConversationLoop.
 */

export interface MicSTTOptions {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (err: Error) => void;
}

export class MicSTT {
  private recognition: SpeechRecognition | null = null;

  constructor(private opts: MicSTTOptions) {}

  start() {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SR) {
      this.opts.onError?.(new Error("SpeechRecognition not supported"));
      return;
    }

    const rec: SpeechRecognition = new SR();

    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const txt = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += txt;
        else interim += txt;
      }

      if (interim) this.opts.onInterim(interim);
      if (final) this.opts.onFinal(final.trim());
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      this.opts.onError?.(new Error(e.error));
    };

    rec.start();

    this.recognition = rec;
  }

  stop() {
    this.recognition?.stop();
    this.recognition = null;
  }
}
