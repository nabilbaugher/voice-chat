import { describe, expect, it } from "vitest";

import { initialState, voiceAppReducer } from "../src/state/machine";

describe("voiceAppReducer", () => {
  it("starts listening when a session begins", () => {
    const state = voiceAppReducer(initialState, {
      type: "SESSION_STARTED",
      sessionId: "session-1",
      contextFileCount: 3
    });

    expect(state.status).toBe("LISTENING");
    expect(state.sessionId).toBe("session-1");
    expect(state.contextFileCount).toBe(3);
  });

  it("prevents overlapping turn starts", () => {
    const listening = voiceAppReducer(initialState, {
      type: "SESSION_STARTED",
      sessionId: "session-1",
      contextFileCount: 1
    });
    const transcribing = voiceAppReducer(listening, { type: "TURN_STARTED", turnId: "turn-1" });
    const ignored = voiceAppReducer(transcribing, { type: "TURN_STARTED", turnId: "turn-2" });

    expect(transcribing.activeTurnId).toBe("turn-1");
    expect(ignored.activeTurnId).toBe("turn-1");
    expect(ignored.status).toBe("TRANSCRIBING");
  });

  it("returns to listening on an empty transcript", () => {
    const listening = voiceAppReducer(initialState, {
      type: "SESSION_STARTED",
      sessionId: "session-1",
      contextFileCount: 0
    });
    const transcribing = voiceAppReducer(listening, { type: "TURN_STARTED", turnId: "turn-1" });
    const next = voiceAppReducer(transcribing, {
      type: "TRANSCRIPTION_SKIPPED",
      turnId: "turn-1"
    });

    expect(next.status).toBe("LISTENING");
    expect(next.activeTurnId).toBeNull();
  });

  it("marks playback complete and returns to listening", () => {
    const listening = voiceAppReducer(initialState, {
      type: "SESSION_STARTED",
      sessionId: "session-1",
      contextFileCount: 0
    });
    const transcribing = voiceAppReducer(listening, { type: "TURN_STARTED", turnId: "turn-1" });
    const thinking = voiceAppReducer(transcribing, {
      type: "TRANSCRIPTION_READY",
      turnId: "turn-1",
      transcript: "Need to think about the roadmap"
    });
    const speaking = voiceAppReducer(thinking, {
      type: "REPLY_READY",
      turnId: "turn-1",
      assistantTurn: {
        id: "assistant-1",
        role: "assistant",
        text: "Here is a careful answer.",
        createdAt: new Date().toISOString(),
        status: "pending",
        interrupted: false,
        playbackStartedAt: null,
        playbackEndedAt: null
      }
    });
    const started = voiceAppReducer(speaking, {
      type: "PLAYBACK_STARTED",
      assistantTurnId: "assistant-1",
      at: "2026-04-18T12:00:00.000Z"
    });
    const ended = voiceAppReducer(started, {
      type: "PLAYBACK_ENDED",
      turnId: "turn-1",
      assistantTurnId: "assistant-1",
      at: "2026-04-18T12:00:03.000Z"
    });

    expect(ended.status).toBe("LISTENING");
    expect(ended.activeTurnId).toBeNull();
    expect(ended.turns.at(-1)?.status).toBe("complete");
    expect(ended.turns.at(-1)?.playbackEndedAt).toBe("2026-04-18T12:00:03.000Z");
  });
});
