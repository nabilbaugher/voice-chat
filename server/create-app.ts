import express from "express";
import cors from "cors";
import multer from "multer";

import type {
  ApiErrorResponse,
  ContextFilesResponse,
  ConversationTurn,
  RespondRequest,
  RespondResponse,
  RespondStreamEvent,
  SessionStartRequest,
  SessionEndedResponse,
  SessionStartResponse,
  TranscriptionResponse
} from "../shared/contracts.js";
import type { AppConfig } from "./config.js";
import { listContextFiles, loadContextBundle } from "./context.js";
import { SessionStore } from "./session-store.js";
import type { BackendServices } from "./services.js";

interface CreateAppOptions {
  config: AppConfig;
  services: BackendServices;
  sessionStore?: SessionStore;
  loadContext?: typeof loadContextBundle;
  listContext?: typeof listContextFiles;
}

const upload = multer({ storage: multer.memoryStorage() });

function sendApiError(
  res: express.Response<ApiErrorResponse>,
  status: number,
  message: string
) {
  res.status(status).json({ error: message });
}

function writeNdjson(res: express.Response, event: RespondStreamEvent) {
  res.write(`${JSON.stringify(event)}\n`);
}

export function createApp({
  config,
  services,
  sessionStore = new SessionStore(),
  loadContext = loadContextBundle,
  listContext = listContextFiles
}: CreateAppOptions): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, model: config.claudeModel });
  });

  app.get<{}, ContextFilesResponse | ApiErrorResponse>("/api/context-files", async (_req, res) => {
    try {
      const filenames = await listContext();
      res.json({ filenames });
    } catch (error) {
      console.error("Failed to list context files", error);
      sendApiError(res, 500, "Unable to list context files.");
    }
  });

  app.post<{}, SessionStartResponse | ApiErrorResponse, SessionStartRequest>("/api/session/start", async (req, res) => {
    const contextFilenames = Array.isArray(req.body.contextFilenames)
      ? req.body.contextFilenames.filter((value): value is string => typeof value === "string")
      : undefined;
    const previousConversations = Array.isArray(req.body.previousConversations)
      ? req.body.previousConversations
          .filter((conversation) => conversation && typeof conversation.id === "string")
          .map((conversation) => ({
            id: conversation.id,
            startedAt:
              typeof conversation.startedAt === "string"
                ? conversation.startedAt
                : new Date().toISOString(),
            turns: Array.isArray(conversation.turns)
              ? conversation.turns
                  .filter(
                    (turn): turn is {
                      role: "user" | "assistant";
                      text: string;
                      kind?: "thinking" | "answer";
                    } =>
                      Boolean(turn) &&
                      (turn.role === "user" || turn.role === "assistant") &&
                      typeof turn.text === "string"
                  )
                  .map((turn) => ({
                    role: turn.role,
                    text: turn.text,
                    kind: turn.kind
                  }))
              : []
          }))
      : [];

    try {
      const contextBundle = await loadContext(undefined, {
        previousConversations,
        selectedFilenames: contextFilenames
      });
      const session = sessionStore.create({
        contextFileCount: contextBundle.fileCount,
        systemPrompt: contextBundle.systemPrompt
      });

      res.json({
        sessionId: session.id,
        contextFileCount: session.contextFileCount
      });
    } catch (error) {
      console.error("Failed to start session", error);
      sendApiError(res, 500, "Unable to load the session context.");
    }
  });

  app.post<{}, TranscriptionResponse | ApiErrorResponse>(
    "/api/transcribe",
    upload.single("audio"),
    async (req, res) => {
      const sessionId = typeof req.body.sessionId === "string" ? req.body.sessionId : "";

      if (!sessionId) {
        return sendApiError(res, 400, "sessionId is required.");
      }

      if (!sessionStore.get(sessionId)) {
        return sendApiError(res, 404, "Session not found.");
      }

      if (!req.file) {
        return sendApiError(res, 400, "Audio upload is required.");
      }

      try {
        const transcript = await services.transcribeAudio({
          buffer: req.file.buffer,
          filename: req.file.originalname || "utterance.wav",
          mimeType: req.file.mimetype || "audio/wav"
        });

        res.json({ transcript: transcript.trim() });
      } catch (error) {
        console.error("Transcription failed", error);
        sendApiError(res, 502, "Transcription failed.");
      }
    }
  );

  app.post<{}, RespondResponse | ApiErrorResponse, RespondRequest>("/api/respond", async (req, res) => {
    const { sessionId, transcript } = req.body;

    if (!sessionId || !transcript) {
      return sendApiError(res, 400, "sessionId and transcript are required.");
    }

    const session = sessionStore.get(sessionId);
    if (!session) {
      return sendApiError(res, 404, "Session not found.");
    }

    const trimmedTranscript = transcript.trim();
    if (!trimmedTranscript) {
      return sendApiError(res, 400, "Transcript cannot be empty.");
    }

    const userTurn: ConversationTurn = {
      id: crypto.randomUUID(),
      role: "user",
      text: trimmedTranscript,
      createdAt: new Date().toISOString(),
      status: "complete",
      interrupted: false,
      playbackStartedAt: null,
      playbackEndedAt: null
    };

    session.turns.push(userTurn);

    try {
      const replyText = await services.generateReply({
        systemPrompt: session.systemPrompt,
        messages: session.turns.map((turn) => ({
          role: turn.role,
          content: turn.text
        }))
      });

      const assistantTurn: ConversationTurn = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: replyText,
        createdAt: new Date().toISOString(),
        status: "complete",
        interrupted: false,
        playbackStartedAt: null,
        playbackEndedAt: null
      };

      session.turns.push(assistantTurn);
      res.json({ replyText });
    } catch (error) {
      console.error("Claude request failed", error);
      sendApiError(res, 502, "Unable to generate a response.");
    }
  });

  app.post("/api/respond/stream", async (req, res) => {
    const { sessionId, transcript } = req.body as RespondRequest;

    if (!sessionId || !transcript) {
      return sendApiError(res, 400, "sessionId and transcript are required.");
    }

    const session = sessionStore.get(sessionId);
    if (!session) {
      return sendApiError(res, 404, "Session not found.");
    }

    const trimmedTranscript = transcript.trim();
    if (!trimmedTranscript) {
      return sendApiError(res, 400, "Transcript cannot be empty.");
    }

    const userTurn: ConversationTurn = {
      id: crypto.randomUUID(),
      role: "user",
      text: trimmedTranscript,
      createdAt: new Date().toISOString(),
      status: "complete",
      interrupted: false,
      playbackStartedAt: null,
      playbackEndedAt: null
    };

    session.turns.push(userTurn);

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
      const { replyText } = await services.streamReply({
        systemPrompt: session.systemPrompt,
        messages: session.turns.map((turn) => ({
          role: turn.role,
          content: turn.text
        })),
        onThinking: (text) => {
          writeNdjson(res, { type: "thinking", text });
        },
        onThinkingComplete: (text) => {
          writeNdjson(res, { type: "thinking_complete", text });
        },
        onAnswer: (text) => {
          writeNdjson(res, { type: "answer", text });
        }
      });

      const assistantTurn: ConversationTurn = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: replyText,
        createdAt: new Date().toISOString(),
        status: "complete",
        interrupted: false,
        playbackStartedAt: null,
        playbackEndedAt: null,
        kind: "answer"
      };

      session.turns.push(assistantTurn);
      writeNdjson(res, { type: "done", replyText });
      res.end();
    } catch (error) {
      console.error("Claude stream request failed", error);
      if (!res.headersSent) {
        sendApiError(res, 502, "Unable to generate a response.");
        return;
      }

      res.write(`${JSON.stringify({ error: "Unable to generate a response." })}\n`);
      res.end();
    }
  });

  app.post<{}, SessionEndedResponse | ApiErrorResponse, { sessionId?: string }>(
    "/api/session/end",
    (req, res) => {
      const sessionId = req.body.sessionId;

      if (!sessionId) {
        return sendApiError(res, 400, "sessionId is required.");
      }

      const ended = sessionStore.delete(sessionId);
      res.json({ ended });
    }
  );

  app.post("/api/tts", async (req, res) => {
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    const speed =
      typeof req.body.speed === "number" && Number.isFinite(req.body.speed) ? req.body.speed : 1;

    if (!text) {
      return sendApiError(res, 400, "text is required.");
    }

    if (speed < 0.25 || speed > 4) {
      return sendApiError(res, 400, "speed must be between 0.25 and 4.");
    }

    try {
      const result = await services.synthesizeSpeech({ text, speed });
      res.setHeader("Content-Type", result.contentType);
      res.send(result.audio);
    } catch (error) {
      console.error("Speech synthesis failed", error);
      sendApiError(res, 502, "Text-to-speech failed.");
    }
  });

  return app;
}
