import Anthropic from "@anthropic-ai/sdk";
import OpenAI, { toFile } from "openai";

import type {
  MessageParam,
  WebSearchTool20250305,
} from "@anthropic-ai/sdk/resources/messages/messages";

import type { AppConfig } from "./config.js";

const OPENAI_RETRY_ATTEMPTS = 3;
const OPENAI_RETRY_BASE_DELAY_MS = 400;
const OPENAI_TTS_MAX_INPUT_CHARS = 3800;

export interface TtsResult {
  audio: Buffer;
  contentType: string;
}

export interface BackendServices {
  transcribeAudio(input: { buffer: Buffer; mimeType: string; filename: string }): Promise<string>;
  generateReply(input: {
    systemPrompt: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }): Promise<string>;
  streamReply(input: {
    systemPrompt: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    onThinking: (snapshot: string) => void;
    onThinkingComplete: (text: string) => void;
    onAnswer: (snapshot: string) => void;
  }): Promise<{ replyText: string }>;
  synthesizeSpeech(input: { text: string; speed?: number }): Promise<TtsResult>;
}

function assertConfigured(value: string, label: string) {
  if (!value) {
    throw new Error(`${label} is missing. Set it in your environment before running the server.`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorCode(error: unknown) {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.cause?.code ?? candidate.code;
}

function getErrorStatus(error: unknown) {
  const candidate = error as { status?: number };
  return candidate.status;
}

export function isRetryableOpenAiError(error: unknown) {
  if (
    error instanceof OpenAI.APIConnectionError ||
    error instanceof OpenAI.APIConnectionTimeoutError
  ) {
    return true;
  }

  const status = getErrorStatus(error);
  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  const code = getErrorCode(error);
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND"
  );
}

export function joinTextBlocks(
  completedBlocks: string[],
  activeBlock: string,
) {
  return [...completedBlocks, activeBlock]
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function chunkTextForTts(
  text: string,
  maxChars = OPENAI_TTS_MAX_INPUT_CHARS,
) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars);
    const splitAt = findChunkBoundary(candidate);
    const chunk = remaining.slice(0, splitAt).trim();

    if (!chunk) {
      break;
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findChunkBoundary(candidate: string) {
  const punctuationMatches = Array.from(candidate.matchAll(/[.!?]\s+/g));
  const punctuationIndex = punctuationMatches.at(-1)?.index;
  if (punctuationIndex !== undefined) {
    return punctuationIndex + 1;
  }

  const clauseMatches = Array.from(candidate.matchAll(/[,;:]\s+/g));
  const clauseIndex = clauseMatches.at(-1)?.index;
  if (clauseIndex !== undefined && clauseIndex > candidate.length * 0.6) {
    return clauseIndex + 1;
  }

  const whitespaceIndex = candidate.lastIndexOf(" ");
  if (whitespaceIndex > candidate.length * 0.6) {
    return whitespaceIndex;
  }

  return candidate.length;
}

async function withOpenAiRetry<T>(label: string, action: () => Promise<T>) {
  for (let attempt = 1; attempt <= OPENAI_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isRetryableOpenAiError(error) || attempt === OPENAI_RETRY_ATTEMPTS) {
        throw error;
      }

      const delayMs = OPENAI_RETRY_BASE_DELAY_MS * attempt;
      console.warn(
        `[openai] ${label} attempt ${attempt} failed with ${
          getErrorCode(error) ?? getErrorStatus(error) ?? "retryable error"
        }. Retrying in ${delayMs}ms.`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`OpenAI ${label} retries exhausted.`);
}

function getClaudeTools(): WebSearchTool20250305[] {
  return [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    },
  ];
}

export function createBackendServices(config: AppConfig): BackendServices {
  assertConfigured(config.openAiApiKey, "OPENAI_API_KEY");
  assertConfigured(config.anthropicApiKey, "ANTHROPIC_API_KEY");

  const openai = new OpenAI({ apiKey: config.openAiApiKey, maxRetries: 0 });
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  return {
    async transcribeAudio({ buffer, mimeType, filename }) {
      const response = await withOpenAiRetry("transcription", async () => {
        const file = await toFile(buffer, filename, { type: mimeType || "audio/wav" });
        return openai.audio.transcriptions.create({
          file,
          model: "whisper-1"
        });
      });

      return response.text.trim();
    },

    async generateReply({ systemPrompt, messages }) {
      const payload: MessageParam[] = messages.map((message) => ({
        role: message.role,
        content: message.content
      }));
      const maxTokens = Math.max(config.claudeMaxTokens, config.claudeThinkingBudget + 1024);

      const response = await anthropic.messages.create({
        model: config.claudeModel,
        system: systemPrompt,
        max_tokens: maxTokens,
        thinking: {
          type: "enabled",
          budget_tokens: config.claudeThinkingBudget
        },
        tools: getClaudeTools(),
        messages: payload
      });

      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    },

    async streamReply({ systemPrompt, messages, onThinking, onThinkingComplete, onAnswer }) {
      const payload: MessageParam[] = messages.map((message) => ({
        role: message.role,
        content: message.content
      }));
      const maxTokens = Math.max(config.claudeMaxTokens, config.claudeThinkingBudget + 1024);
      const completedAnswerBlocks: string[] = [];
      let activeAnswerBlock = "";
      const stream = anthropic.messages.stream({
        model: config.claudeModel,
        system: systemPrompt,
        max_tokens: maxTokens,
        thinking: {
          type: "enabled",
          budget_tokens: config.claudeThinkingBudget
        },
        tools: getClaudeTools(),
        messages: payload
      });

      stream.on("thinking", (_thinkingDelta, thinkingSnapshot) => {
        onThinking(thinkingSnapshot);
      });

      stream.on("text", (_textDelta, textSnapshot) => {
        activeAnswerBlock = textSnapshot;
        onAnswer(joinTextBlocks(completedAnswerBlocks, activeAnswerBlock));
      });

      stream.on("contentBlock", (content) => {
        if (content.type === "thinking") {
          onThinkingComplete(content.thinking);
          return;
        }

        if (content.type === "text") {
          completedAnswerBlocks.push(content.text);
          activeAnswerBlock = "";
          onAnswer(joinTextBlocks(completedAnswerBlocks, activeAnswerBlock));
        }
      });

      const finalMessage = await stream.finalMessage();
      const replyText = finalMessage.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      return { replyText };
    },

    async synthesizeSpeech({ text, speed }) {
      const chunks = chunkTextForTts(text);
      const audioParts: Buffer[] = [];

      for (const [index, chunk] of chunks.entries()) {
        const response = await withOpenAiRetry(
          `speech synthesis chunk ${index + 1}/${chunks.length}`,
          () =>
            openai.audio.speech.create({
              model: config.ttsModel,
              voice: config.ttsVoice,
              input: chunk,
              response_format: "mp3",
              speed
            })
        );

        audioParts.push(Buffer.from(await response.arrayBuffer()));
      }

      return {
        audio: Buffer.concat(audioParts),
        contentType: "audio/mpeg"
      };
    }
  };
}
