import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import {
  chunkTextForTts,
  isRetryableOpenAiError,
  joinTextBlocks,
} from "../server/services.js";

describe("isRetryableOpenAiError", () => {
  it("treats connection resets as retryable", () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const error = new OpenAI.APIConnectionError({
      message: "Connection error.",
      cause
    });

    expect(isRetryableOpenAiError(error)).toBe(true);
  });

  it("treats rate limits as retryable", () => {
    expect(isRetryableOpenAiError({ status: 429 })).toBe(true);
  });

  it("does not retry invalid requests", () => {
    expect(isRetryableOpenAiError({ status: 400 })).toBe(false);
  });

  it("joins streamed text blocks across tool boundaries", () => {
    expect(joinTextBlocks(["First block from before search."], "Second block after search.")).toBe(
      "First block from before search.\n\nSecond block after search."
    );
  });

  it("chunks long tts input on sentence boundaries", () => {
    const text =
      "One short sentence. Two short sentence. Three short sentence. Four short sentence.";

    expect(chunkTextForTts(text, 35)).toEqual([
      "One short sentence.",
      "Two short sentence.",
      "Three short sentence.",
      "Four short sentence."
    ]);
  });

  it("falls back to whitespace boundaries when no punctuation exists", () => {
    const text =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";

    const chunks = chunkTextForTts(text, 24);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });
});
