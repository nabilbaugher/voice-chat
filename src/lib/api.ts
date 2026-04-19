import type {
  ApiErrorResponse,
  ContextFilesResponse,
  PreviousConversationContext,
  RespondResponse,
  RespondStreamEvent,
  SessionStartRequest,
  SessionEndedResponse,
  SessionStartResponse,
  TtsRequest,
  TranscriptionResponse
} from "../../shared/contracts";

async function parseJsonOrError<T>(response: Response): Promise<T> {
  if (response.ok) {
    return (await response.json()) as T;
  }

  const error = (await response.json().catch(() => null)) as ApiErrorResponse | null;
  throw new Error(error?.error ?? "Request failed.");
}

export async function fetchContextFiles() {
  const response = await fetch("/api/context-files");
  return parseJsonOrError<ContextFilesResponse>(response);
}

export async function startSession(payload: {
  contextFilenames?: string[];
  previousConversations?: PreviousConversationContext[];
} = {}) {
  const response = await fetch("/api/session/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload satisfies SessionStartRequest)
  });

  return parseJsonOrError<SessionStartResponse>(response);
}

export async function endSession(sessionId: string) {
  const response = await fetch("/api/session/end", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sessionId })
  });

  return parseJsonOrError<SessionEndedResponse>(response);
}

export async function transcribeAudio(sessionId: string, audio: Blob) {
  const formData = new FormData();
  formData.append("sessionId", sessionId);
  formData.append("audio", audio, getAudioFilename(audio.type));

  const response = await fetch("/api/transcribe", {
    method: "POST",
    body: formData
  });

  return parseJsonOrError<TranscriptionResponse>(response);
}

function getAudioFilename(mimeType: string) {
  if (mimeType.includes("mp4")) {
    return "utterance.m4a";
  }

  if (mimeType.includes("ogg")) {
    return "utterance.ogg";
  }

  if (mimeType.includes("webm")) {
    return "utterance.webm";
  }

  return "utterance.wav";
}

export async function fetchReply(sessionId: string, transcript: string) {
  const response = await fetch("/api/respond", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sessionId, transcript })
  });

  return parseJsonOrError<RespondResponse>(response);
}

export async function streamReply(
  sessionId: string,
  transcript: string,
  handlers: {
    onEvent: (event: RespondStreamEvent) => void;
  }
) {
  const response = await fetch("/api/respond/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sessionId, transcript })
  });

  if (!response.ok || !response.body) {
    const error = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new Error(error?.error ?? "Streaming reply failed.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let finalReplyText = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line) as RespondStreamEvent | ApiErrorResponse;
      if ("error" in event) {
        throw new Error(event.error);
      }

      if (event.type === "done") {
        finalReplyText = event.replyText;
      }

      handlers.onEvent(event);
    }
  }

  if (buffer.trim()) {
    const event = JSON.parse(buffer) as RespondStreamEvent | ApiErrorResponse;
    if ("error" in event) {
      throw new Error(event.error);
    }

    if (event.type === "done") {
      finalReplyText = event.replyText;
    }

    handlers.onEvent(event);
  }

  return { replyText: finalReplyText };
}

export async function fetchTtsAudio(payload: TtsRequest) {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new Error(error?.error ?? "Text-to-speech failed.");
  }

  return new Blob([await response.arrayBuffer()], {
    type: response.headers.get("content-type") ?? "audio/mpeg"
  });
}
