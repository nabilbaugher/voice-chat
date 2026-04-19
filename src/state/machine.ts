import type { ClientState, ConversationTurn } from "../../shared/contracts";

export interface VoiceAppState {
  status: ClientState;
  sessionId: string | null;
  turns: ConversationTurn[];
  activeTurnId: string | null;
  error: string | null;
  contextFileCount: number;
}

export type VoiceAppAction =
  | { type: "SESSION_STARTED"; sessionId: string; contextFileCount: number }
  | { type: "SESSION_STOPPED" }
  | { type: "TURN_STARTED"; turnId: string }
  | { type: "TRANSCRIPTION_SKIPPED"; turnId: string }
  | { type: "TRANSCRIPTION_READY"; turnId: string; transcript: string }
  | { type: "REPLY_READY"; turnId: string; assistantTurn: ConversationTurn }
  | { type: "ASSISTANT_TURN_ADDED"; turn: ConversationTurn }
  | { type: "ASSISTANT_TURN_UPDATED"; turnId: string; text: string }
  | { type: "ASSISTANT_TURN_COMPLETED"; turnId: string }
  | { type: "PLAYBACK_STARTED"; assistantTurnId: string; at: string }
  | { type: "PLAYBACK_ENDED"; turnId: string; assistantTurnId: string; at: string }
  | { type: "ERROR"; message: string }
  | { type: "RESET_ERROR" };

export const initialState: VoiceAppState = {
  status: "IDLE",
  sessionId: null,
  turns: [],
  activeTurnId: null,
  error: null,
  contextFileCount: 0
};

export function voiceAppReducer(state: VoiceAppState, action: VoiceAppAction): VoiceAppState {
  switch (action.type) {
    case "SESSION_STARTED":
      return {
        status: "LISTENING",
        sessionId: action.sessionId,
        turns: [],
        activeTurnId: null,
        error: null,
        contextFileCount: action.contextFileCount
      };

    case "SESSION_STOPPED":
      return { ...initialState };

    case "TURN_STARTED":
      if (state.status !== "LISTENING" || state.activeTurnId) {
        return state;
      }

      return {
        ...state,
        status: "TRANSCRIBING",
        activeTurnId: action.turnId,
        error: null
      };

    case "TRANSCRIPTION_SKIPPED":
      if (state.activeTurnId !== action.turnId) {
        return state;
      }

      return {
        ...state,
        status: "LISTENING",
        activeTurnId: null
      };

    case "TRANSCRIPTION_READY":
      if (state.activeTurnId !== action.turnId) {
        return state;
      }

      return {
        ...state,
        status: "THINKING",
        turns: [
          ...state.turns,
          {
            id: crypto.randomUUID(),
            role: "user",
            text: action.transcript,
            createdAt: new Date().toISOString(),
            status: "complete",
            interrupted: false,
            playbackStartedAt: null,
            playbackEndedAt: null
          }
        ]
      };

    case "REPLY_READY":
      if (state.activeTurnId !== action.turnId) {
        return state;
      }

      return {
        ...state,
        status: "SPEAKING",
        turns: [...state.turns, action.assistantTurn]
      };

    case "ASSISTANT_TURN_ADDED":
      return {
        ...state,
        turns: [...state.turns, action.turn]
      };

    case "ASSISTANT_TURN_UPDATED":
      return {
        ...state,
        turns: state.turns.map((turn) =>
          turn.id === action.turnId
            ? {
                ...turn,
                text: action.text
              }
            : turn
        )
      };

    case "ASSISTANT_TURN_COMPLETED":
      return {
        ...state,
        turns: state.turns.map((turn) =>
          turn.id === action.turnId
            ? {
                ...turn,
                status: "complete"
              }
            : turn
        )
      };

    case "PLAYBACK_STARTED":
      return {
        ...state,
        status: "SPEAKING",
        turns: state.turns.map((turn) =>
          turn.id === action.assistantTurnId
            ? { ...turn, playbackStartedAt: action.at }
            : turn
        )
      };

    case "PLAYBACK_ENDED":
      if (state.activeTurnId !== action.turnId) {
        return state;
      }

      return {
        ...state,
        status: "LISTENING",
        activeTurnId: null,
        turns: state.turns.map((turn) =>
          turn.id === action.assistantTurnId
            ? {
                ...turn,
                status: "complete",
                playbackEndedAt: action.at
              }
            : turn
        )
      };

    case "ERROR":
      return {
        ...state,
        status: "ERROR",
        activeTurnId: null,
        error: action.message
      };

    case "RESET_ERROR":
      return {
        ...state,
        status: state.sessionId ? "LISTENING" : "IDLE",
        error: null
      };

    default:
      return state;
  }
}

export function getStatusCopy(status: ClientState) {
  switch (status) {
    case "IDLE":
      return "Ready to start";
    case "LISTENING":
      return "Listening for your next thought";
    case "TRANSCRIBING":
      return "Transcribing your utterance";
    case "THINKING":
      return "Thinking through the response";
    case "SPEAKING":
      return "Speaking the reply";
    case "ERROR":
      return "Something interrupted the loop";
  }
}
