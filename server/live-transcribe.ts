import type { Server as HttpServer, IncomingMessage } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import type {
  LiveTranscriptionClientMessage,
  LiveTranscriptionServerMessage,
} from "../shared/contracts.js";
import type { AppConfig } from "./config.js";
import type { SessionStore } from "./session-store.js";

interface TranscriptAccumulator {
  finalized: string[];
  interim: string;
}

const FINALIZE_DEBOUNCE_MS = 500;
const FINALIZE_FALLBACK_MS = 1800;

export function attachLiveTranscriptionServer(input: {
  server: HttpServer;
  config: AppConfig;
  sessionStore: SessionStore;
}) {
  const wss = new WebSocketServer({ noServer: true });

  input.server.on("upgrade", (request, socket, head) => {
    const url = safeParseUrl(request);
    if (!url || url.pathname !== "/api/live-transcribe") {
      return;
    }

    wss.handleUpgrade(request, socket, head, (clientSocket) => {
      wss.emit("connection", clientSocket, request);
    });
  });

  wss.on("connection", (clientSocket, request) => {
    const url = safeParseUrl(request);
    const sessionId = url?.searchParams.get("sessionId")?.trim() ?? "";
    const sampleRate = Number.parseInt(url?.searchParams.get("sampleRate") ?? "", 10);

    if (!sessionId || !input.sessionStore.get(sessionId)) {
      sendServerEvent(clientSocket, {
        type: "error",
        message: "Session not found.",
      });
      clientSocket.close(1008, "Session not found");
      return;
    }

    if (!input.config.deepgramApiKey) {
      sendServerEvent(clientSocket, {
        type: "error",
        message: "DEEPGRAM_API_KEY is missing on the server.",
      });
      clientSocket.close(1011, "Deepgram unavailable");
      return;
    }

    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      sendServerEvent(clientSocket, {
        type: "error",
        message: "A valid sampleRate is required for live transcription.",
      });
      clientSocket.close(1008, "Invalid sample rate");
      return;
    }

    const deepgramSocket = new WebSocket(buildDeepgramUrl(input.config, sampleRate), {
      headers: {
        Authorization: `Token ${input.config.deepgramApiKey}`,
      },
    });

    let transcriptState: TranscriptAccumulator = {
      finalized: [],
      interim: "",
    };
    let finalizeTimer: NodeJS.Timeout | null = null;
    let finalizeRequested = false;
    let finalTranscriptSent = false;

    const clearFinalizeTimer = () => {
      if (finalizeTimer) {
        clearTimeout(finalizeTimer);
        finalizeTimer = null;
      }
    };

    const sendFinalTranscriptAndClose = () => {
      if (finalTranscriptSent) {
        return;
      }

      finalTranscriptSent = true;
      clearFinalizeTimer();
      sendServerEvent(clientSocket, {
        type: "final_transcript",
        text: getTranscriptText(transcriptState),
      });
      deepgramSocket.close();
      clientSocket.close();
    };

    const scheduleFinalizeClose = (delayMs: number) => {
      clearFinalizeTimer();
      finalizeTimer = setTimeout(() => {
        sendFinalTranscriptAndClose();
      }, delayMs);
    };

    deepgramSocket.on("open", () => {
      sendServerEvent(clientSocket, { type: "ready" });
    });

    deepgramSocket.on("message", (payload, isBinary) => {
      if (isBinary) {
        return;
      }

      try {
        const message = JSON.parse(payload.toString()) as DeepgramStreamingMessage;
        if (!isTranscriptMessage(message)) {
          return;
        }

        const transcript = message.channel.alternatives[0]?.transcript?.trim() ?? "";
        if (!transcript) {
          if (finalizeRequested) {
            scheduleFinalizeClose(FINALIZE_DEBOUNCE_MS);
          }
          return;
        }

        transcriptState = applyTranscriptUpdate(transcriptState, transcript, message.is_final);
        sendServerEvent(clientSocket, {
          type: "transcript",
          text: getTranscriptText(transcriptState),
          isFinal: message.is_final,
          speechFinal: message.speech_final,
        });

        if (finalizeRequested) {
          scheduleFinalizeClose(FINALIZE_DEBOUNCE_MS);
        }
      } catch (error) {
        console.error("Deepgram stream payload failed", error);
      }
    });

    deepgramSocket.on("error", (error) => {
      console.error("Deepgram live transcription failed", error);
      sendServerEvent(clientSocket, {
        type: "error",
        message: "Deepgram live transcription failed.",
      });
      clientSocket.close(1011, "Deepgram failure");
    });

    deepgramSocket.on("close", () => {
      if (finalizeRequested && !finalTranscriptSent) {
        sendFinalTranscriptAndClose();
        return;
      }

      clearFinalizeTimer();
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    });

    clientSocket.on("message", (payload, isBinary) => {
      if (isBinary) {
        if (deepgramSocket.readyState === WebSocket.OPEN) {
          deepgramSocket.send(payload, { binary: true });
        }
        return;
      }

      try {
        const message = JSON.parse(payload.toString()) as LiveTranscriptionClientMessage;
        if (message.type !== "finalize" || finalizeRequested) {
          return;
        }

        finalizeRequested = true;
        if (deepgramSocket.readyState === WebSocket.OPEN) {
          deepgramSocket.send(JSON.stringify({ type: "Finalize" }));
        }
        scheduleFinalizeClose(FINALIZE_FALLBACK_MS);
      } catch (error) {
        console.error("Invalid live transcription client message", error);
      }
    });

    clientSocket.on("close", () => {
      clearFinalizeTimer();
      deepgramSocket.close();
    });

    clientSocket.on("error", (error) => {
      console.error("Live transcription client socket failed", error);
      clearFinalizeTimer();
      deepgramSocket.close();
    });
  });

  return wss;
}

export function applyTranscriptUpdate(
  state: TranscriptAccumulator,
  transcript: string,
  isFinal: boolean,
): TranscriptAccumulator {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) {
    return state;
  }

  if (!isFinal) {
    return {
      ...state,
      interim: trimmedTranscript,
    };
  }

  if (state.finalized.at(-1) === trimmedTranscript) {
    return {
      finalized: [...state.finalized],
      interim: "",
    };
  }

  return {
    finalized: [...state.finalized, trimmedTranscript],
    interim: "",
  };
}

export function getTranscriptText(state: TranscriptAccumulator) {
  return [...state.finalized, state.interim]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDeepgramUrl(config: AppConfig, sampleRate: number) {
  const url = new URL("wss://api.deepgram.com/v1/listen");
  url.searchParams.set("model", config.deepgramStreamingModel);
  url.searchParams.set("language", config.deepgramLanguage);
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(sampleRate));
  url.searchParams.set("channels", "1");
  url.searchParams.set("endpointing", "false");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("smart_format", "true");
  return url.toString();
}

function safeParseUrl(request: IncomingMessage) {
  try {
    return new URL(request.url ?? "", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    return null;
  }
}

function sendServerEvent(socket: WebSocket, event: LiveTranscriptionServerMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function isTranscriptMessage(message: DeepgramStreamingMessage): message is DeepgramTranscriptMessage {
  const candidate = message as {
    channel?: {
      alternatives?: unknown[];
    };
  };

  return Array.isArray(candidate.channel?.alternatives) && candidate.channel.alternatives.length > 0;
}

interface DeepgramTranscriptMessage {
  channel: {
    alternatives: Array<{
      transcript?: string;
    }>;
  };
  is_final: boolean;
  speech_final: boolean;
}

type DeepgramStreamingMessage = DeepgramTranscriptMessage | Record<string, unknown>;
