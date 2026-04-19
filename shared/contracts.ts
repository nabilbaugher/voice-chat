export type ClientState =
  | "IDLE"
  | "LISTENING"
  | "TRANSCRIBING"
  | "THINKING"
  | "SPEAKING"
  | "ERROR";

export type TurnRole = "user" | "assistant";
export type TurnStatus = "pending" | "complete" | "error";
export type AssistantTurnKind = "thinking" | "answer";

export interface ConversationTurn {
  id: string;
  role: TurnRole;
  text: string;
  createdAt: string;
  status: TurnStatus;
  interrupted: boolean;
  playbackStartedAt: string | null;
  playbackEndedAt: string | null;
  kind?: AssistantTurnKind;
}

export interface SessionStartResponse {
  sessionId: string;
  contextFileCount: number;
}

export interface PreviousConversationContext {
  id: string;
  startedAt: string;
  turns: Array<{
    role: TurnRole;
    text: string;
    kind?: AssistantTurnKind;
  }>;
}

export interface SessionStartRequest {
  contextFilenames?: string[];
  previousConversations?: PreviousConversationContext[];
}

export interface ContextFilesResponse {
  filenames: string[];
}

export interface TranscriptionResponse {
  transcript: string;
}

export interface RespondRequest {
  sessionId: string;
  transcript: string;
}

export interface RespondResponse {
  replyText: string;
}

export type RespondStreamEvent =
  | { type: "thinking"; text: string }
  | { type: "thinking_complete"; text: string }
  | { type: "answer"; text: string }
  | { type: "done"; replyText: string };

export interface TtsRequest {
  text: string;
  speed?: number;
}

export interface ApiErrorResponse {
  error: string;
}

export interface SessionEndedResponse {
  ended: boolean;
}

export type LiveTranscriptionClientMessage = { type: "finalize" };

export type LiveTranscriptionServerMessage =
  | { type: "ready" }
  | {
      type: "transcript";
      text: string;
      isFinal: boolean;
      speechFinal: boolean;
    }
  | { type: "final_transcript"; text: string }
  | { type: "error"; message: string };
