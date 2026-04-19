const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

interface PlaybackCallbacks {
  onStart?: () => void;
  onEnd?: () => void;
}

export class AudioController {
  private readonly audio = new Audio();
  private currentUrl: string | null = null;
  private speechUtterance: SpeechSynthesisUtterance | null = null;

  constructor() {
    this.audio.preload = "auto";
    this.audio.setAttribute("playsinline", "true");
  }

  async unlock() {
    try {
      this.audio.src = SILENT_WAV_DATA_URI;
      await this.audio.play();
      this.audio.pause();
      this.audio.currentTime = 0;
    } catch {
      // Safari may still require the first real play call to be gesture-adjacent.
    } finally {
      this.audio.src = "";
    }
  }

  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;

    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }

    if (this.speechUtterance && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
    }

    this.speechUtterance = null;
  }

  async playBlob(blob: Blob, callbacks: PlaybackCallbacks = {}) {
    this.stop();

    return new Promise<void>(async (resolve, reject) => {
      this.currentUrl = URL.createObjectURL(blob);
      this.audio.src = this.currentUrl;

      this.audio.onplaying = () => callbacks.onStart?.();
      this.audio.onended = () => {
        callbacks.onEnd?.();
        if (this.currentUrl) {
          URL.revokeObjectURL(this.currentUrl);
          this.currentUrl = null;
        }
        resolve();
      };
      this.audio.onerror = () => {
        reject(new Error("Audio playback failed."));
      };

      try {
        await this.audio.play();
      } catch (error) {
        reject(error);
      }
    });
  }

  speakFallback(text: string, callbacks: PlaybackCallbacks = {}) {
    this.stop();

    return new Promise<void>((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        reject(new Error("Browser speech synthesis is unavailable."));
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onstart = () => callbacks.onStart?.();
      utterance.onend = () => {
        callbacks.onEnd?.();
        resolve();
      };
      utterance.onerror = (event) => {
        reject(new Error(event.error));
      };

      this.speechUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    });
  }
}
