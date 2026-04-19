import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { getConfig } from "../server/config.js";
import { createApp } from "../server/create-app.js";

describe("server API", () => {
  it("starts a session, transcribes audio, responds, synthesizes speech, and ends the session", async () => {
    const loadContext = vi.fn().mockResolvedValue({
      fileCount: 2,
      filenames: ["a.md", "b.md"],
      systemPrompt: "mock prompt"
    });
    const app = createApp({
      config: {
        ...getConfig(),
        openAiApiKey: "test-openai",
        anthropicApiKey: "test-anthropic"
      },
      listContext: vi.fn().mockResolvedValue(["a.md", "b.md"]),
      loadContext,
      services: {
        transcribeAudio: vi.fn().mockResolvedValue("walk me through the tradeoffs"),
        generateReply: vi.fn().mockResolvedValue("Here is a grounded answer."),
        streamReply: vi.fn().mockImplementation(async ({ onThinking, onThinkingComplete, onAnswer }) => {
          onThinking("First, let me think through the tradeoffs.");
          onThinkingComplete("First, let me think through the tradeoffs.");
          onAnswer("Here is a grounded answer.");
          return { replyText: "Here is a grounded answer." };
        }),
        synthesizeSpeech: vi.fn().mockResolvedValue({
          audio: Buffer.from("mp3"),
          contentType: "audio/mpeg"
        })
      }
    });

    const contextFiles = await request(app).get("/api/context-files");
    expect(contextFiles.status).toBe(200);
    expect(contextFiles.body.filenames).toEqual(["a.md", "b.md"]);

    const start = await request(app)
      .post("/api/session/start")
      .send({
        contextFilenames: ["b.md"],
        previousConversations: [
          {
            id: "saved-1",
            startedAt: "2026-04-19T12:00:00.000Z",
            turns: [
              { role: "user", text: "Earlier question" },
              { role: "assistant", text: "Earlier answer", kind: "answer" }
            ]
          }
        ]
      });
    expect(start.status).toBe(200);
    expect(start.body.contextFileCount).toBe(2);
    expect(loadContext).toHaveBeenCalledWith(undefined, {
      previousConversations: [
        {
          id: "saved-1",
          startedAt: "2026-04-19T12:00:00.000Z",
          turns: [
            { role: "user", text: "Earlier question", kind: undefined },
            { role: "assistant", text: "Earlier answer", kind: "answer" }
          ]
        }
      ],
      selectedFilenames: ["b.md"]
    });

    const sessionId = start.body.sessionId as string;

    const transcribe = await request(app)
      .post("/api/transcribe")
      .field("sessionId", sessionId)
      .attach("audio", Buffer.from("wav"), {
        filename: "utterance.wav",
        contentType: "audio/wav"
      });

    expect(transcribe.status).toBe(200);
    expect(transcribe.body.transcript).toBe("walk me through the tradeoffs");

    const respond = await request(app)
      .post("/api/respond")
      .send({ sessionId, transcript: "walk me through the tradeoffs" });

    expect(respond.status).toBe(200);
    expect(respond.body.replyText).toBe("Here is a grounded answer.");

    const tts = await request(app).post("/api/tts").send({ text: "Here is a grounded answer." });

    expect(tts.status).toBe(200);
    expect(tts.header["content-type"]).toContain("audio/mpeg");

    const ended = await request(app).post("/api/session/end").send({ sessionId });
    expect(ended.status).toBe(200);
    expect(ended.body.ended).toBe(true);
  });

  it("returns 404 for an unknown session during transcription", async () => {
    const app = createApp({
      config: {
        ...getConfig(),
        openAiApiKey: "test-openai",
        anthropicApiKey: "test-anthropic"
      },
      services: {
        transcribeAudio: vi.fn(),
        generateReply: vi.fn(),
        streamReply: vi.fn(),
        synthesizeSpeech: vi.fn()
      }
    });

    const response = await request(app)
      .post("/api/transcribe")
      .field("sessionId", "missing-session")
      .attach("audio", Buffer.from("wav"), {
        filename: "utterance.wav",
        contentType: "audio/wav"
      });

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("Session not found");
  });

  it("streams thinking traces and the final answer", async () => {
    const app = createApp({
      config: {
        ...getConfig(),
        openAiApiKey: "test-openai",
        anthropicApiKey: "test-anthropic"
      },
      loadContext: vi.fn().mockResolvedValue({
        fileCount: 1,
        filenames: ["a.md"],
        systemPrompt: "mock prompt"
      }),
      services: {
        transcribeAudio: vi.fn(),
        generateReply: vi.fn(),
        streamReply: vi.fn().mockImplementation(async ({ onThinking, onThinkingComplete, onAnswer }) => {
          onThinking("Thinking trace");
          onThinkingComplete("Thinking trace");
          onAnswer("Final answer");
          return { replyText: "Final answer" };
        }),
        synthesizeSpeech: vi.fn()
      }
    });

    const start = await request(app).post("/api/session/start").send({});
    const sessionId = start.body.sessionId as string;

    const response = await request(app)
      .post("/api/respond/stream")
      .send({ sessionId, transcript: "tell me what you think" });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"type":"thinking"');
    expect(response.text).toContain('"type":"thinking_complete"');
    expect(response.text).toContain('"type":"answer"');
    expect(response.text).toContain('"type":"done"');
  });

  it("validates tts speed bounds", async () => {
    const app = createApp({
      config: {
        ...getConfig(),
        openAiApiKey: "test-openai",
        anthropicApiKey: "test-anthropic"
      },
      services: {
        transcribeAudio: vi.fn(),
        generateReply: vi.fn(),
        streamReply: vi.fn(),
        synthesizeSpeech: vi.fn()
      }
    });

    const response = await request(app).post("/api/tts").send({ text: "test", speed: 5 });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("speed must be between 0.25 and 4");
  });
});
