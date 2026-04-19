import type { ConversationTurn } from "../../shared/contracts";

const STORAGE_KEY = "voice-claude.saved-transcripts";
const MAX_SAVED_SESSIONS = 40;

export interface SavedTranscriptSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  contextFileCount: number;
  turns: ConversationTurn[];
}

export function getSavedTranscriptSessions(): SavedTranscriptSession[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as SavedTranscriptSession[];
    return parsed
      .filter((session) => session.id && Array.isArray(session.turns))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  } catch {
    return [];
  }
}

export function upsertSavedTranscriptSession(session: SavedTranscriptSession) {
  if (typeof window === "undefined") {
    return [];
  }

  const sessions = getSavedTranscriptSessions();
  const next = [
    session,
    ...sessions.filter((existing) => existing.id !== session.id),
  ]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, MAX_SAVED_SESSIONS);

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function finalizeSavedTranscriptSession(sessionId: string, endedAt: string) {
  if (typeof window === "undefined") {
    return [];
  }

  const next = getSavedTranscriptSessions().map((session) =>
    session.id === sessionId
      ? {
          ...session,
          endedAt,
        }
      : session,
  );

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
