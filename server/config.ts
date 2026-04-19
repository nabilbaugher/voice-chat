import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  port: number;
  openAiApiKey: string;
  anthropicApiKey: string;
  deepgramApiKey: string;
  claudeModel: string;
  claudeMaxTokens: number;
  claudeThinkingBudget: number;
  ttsModel: string;
  ttsVoice: string;
  deepgramStreamingModel: string;
  deepgramLanguage: string;
}

function parseNumber(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getConfig(): AppConfig {
  return {
    port: parseNumber(process.env.PORT, 3001),
    openAiApiKey: process.env.OPENAI_API_KEY ?? "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
    claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
    claudeMaxTokens: parseNumber(process.env.CLAUDE_MAX_TOKENS, 9600),
    claudeThinkingBudget: parseNumber(process.env.CLAUDE_THINKING_BUDGET, 8000),
    ttsModel: process.env.TTS_MODEL ?? "tts-1",
    ttsVoice: process.env.TTS_VOICE ?? "alloy",
    deepgramStreamingModel: process.env.DEEPGRAM_STREAMING_MODEL ?? "nova-3",
    deepgramLanguage: process.env.DEEPGRAM_LANGUAGE ?? "en-US"
  };
}
