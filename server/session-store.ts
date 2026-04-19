import { randomUUID } from "node:crypto";

import type { ConversationTurn } from "../shared/contracts.js";

export interface ServerSession {
  id: string;
  createdAt: string;
  contextFileCount: number;
  systemPrompt: string;
  turns: ConversationTurn[];
}

export class SessionStore {
  private readonly sessions = new Map<string, ServerSession>();

  create(input: Omit<ServerSession, "id" | "createdAt" | "turns">) {
    const session: ServerSession = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      turns: [],
      ...input
    };

    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }

  update(sessionId: string, updater: (session: ServerSession) => ServerSession) {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return null;
    }

    const next = updater(current);
    this.sessions.set(sessionId, next);
    return next;
  }

  delete(sessionId: string) {
    return this.sessions.delete(sessionId);
  }
}
