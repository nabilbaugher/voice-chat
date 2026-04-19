import type {
  LiveTranscriptionClientMessage,
  LiveTranscriptionServerMessage,
} from "../../shared/contracts";

interface LiveTranscriptionInput {
  sessionId: string;
  onError: (error: Error) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
}

type BrowserAudioContext = AudioContext;
type BrowserAudioContextCtor = typeof AudioContext;

export class LiveTranscriptionController {
  private readonly sessionId: string;
  private readonly onError: (error: Error) => void;
  private readonly onTranscript: (text: string, isFinal: boolean) => void;

  private audioContext: BrowserAudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private socket: WebSocket | null = null;
  private finalizePromise: Promise<string> | null = null;
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizeReject: ((reason?: unknown) => void) | null = null;
  private isStoppingCapture = false;

  constructor(input: LiveTranscriptionInput) {
    this.sessionId = input.sessionId;
    this.onError = input.onError;
    this.onTranscript = input.onTranscript;
  }

  async start() {
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor) {
      throw new Error("Web Audio is unavailable in this browser.");
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContextCtor();
    await this.audioContext.resume();
    this.socket = await openLiveTranscriptionSocket(this.sessionId, this.audioContext.sampleRate);
    this.socket.onmessage = (event) => {
      this.handleServerMessage(event.data);
    };
    this.socket.onerror = () => {
      this.onError(new Error("Live transcription socket failed."));
    };
    this.socket.onclose = () => {
      if (!this.finalizePromise && !this.isStoppingCapture) {
        this.onError(new Error("Live transcription disconnected."));
      }
    };

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.sink = this.audioContext.createGain();
    this.sink.gain.value = 0;

    this.processor.onaudioprocess = (event) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.isStoppingCapture) {
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      this.socket.send(convertFloat32ToInt16(input));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.audioContext.destination);
  }

  async finalize() {
    if (this.finalizePromise) {
      return this.finalizePromise;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Live transcription is not connected.");
    }

    this.stopCapture();
    this.finalizePromise = new Promise<string>((resolve, reject) => {
      this.finalizeResolve = resolve;
      this.finalizeReject = reject;

      const message: LiveTranscriptionClientMessage = { type: "finalize" };
      this.socket?.send(JSON.stringify(message));
    });

    return this.finalizePromise;
  }

  stop() {
    this.stopCapture();
    this.rejectFinalize(new Error("Live transcription stopped."));
    this.socket?.close();
    this.socket = null;
  }

  private stopCapture() {
    this.isStoppingCapture = true;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.processor = null;
    this.source = null;
    this.sink = null;

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;

    void this.audioContext?.close();
    this.audioContext = null;
  }

  private handleServerMessage(payload: string) {
    try {
      const event = JSON.parse(payload) as LiveTranscriptionServerMessage;
      switch (event.type) {
        case "ready":
          return;
        case "transcript":
          this.onTranscript(event.text, event.isFinal);
          return;
        case "final_transcript":
          this.finalizeResolve?.(event.text.trim());
          this.finalizeResolve = null;
          this.finalizeReject = null;
          this.finalizePromise = null;
          this.socket?.close();
          this.socket = null;
          return;
        case "error":
          this.rejectFinalize(new Error(event.message));
          this.onError(new Error(event.message));
          return;
      }
    } catch (error) {
      this.rejectFinalize(error);
      this.onError(new Error("Live transcription returned invalid data."));
    }
  }

  private rejectFinalize(error: unknown) {
    this.finalizeReject?.(error);
    this.finalizeResolve = null;
    this.finalizeReject = null;
    this.finalizePromise = null;
  }
}

function getAudioContextConstructor(): BrowserAudioContextCtor | null {
  if ("AudioContext" in window) {
    return window.AudioContext;
  }

  const candidate = window as Window & {
    webkitAudioContext?: BrowserAudioContextCtor;
  };
  return candidate.webkitAudioContext ?? null;
}

function openLiveTranscriptionSocket(sessionId: string, sampleRate: number) {
  return new Promise<WebSocket>((resolve, reject) => {
    const url = new URL(
      "/api/live-transcribe",
      `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`,
    );
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("sampleRate", String(Math.round(sampleRate)));

    const socket = new WebSocket(url);
    let settled = false;

    socket.onopen = () => {
      // Wait for the server's ready event before resolving.
    };
    socket.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error("Unable to connect to live transcription."));
      }
    };
    socket.onclose = () => {
      if (!settled) {
        settled = true;
        reject(new Error("Live transcription closed before it became ready."));
      }
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as LiveTranscriptionServerMessage;
        if (message.type === "ready" && !settled) {
          settled = true;
          resolve(socket);
          return;
        }

        if (message.type === "error" && !settled) {
          settled = true;
          reject(new Error(message.message));
        }
      } catch {
        if (!settled) {
          settled = true;
          reject(new Error("Live transcription handshake failed."));
        }
      }
    };
  });
}

function convertFloat32ToInt16(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);

  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}
