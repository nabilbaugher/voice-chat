import { describe, expect, it } from "vitest";

import { findStreamingTtsChunk } from "../src/lib/streaming-tts";

describe("findStreamingTtsChunk", () => {
  it("yields once multiple complete short sentences are available", () => {
    expect(
      findStreamingTtsChunk(
        "Short sentence. Another short one.",
        0,
        false,
      ),
    ).toEqual({
      chunk: "Short sentence. Another short one.",
      nextConsumedChars: "Short sentence. Another short one.".length,
    });
  });

  it("yields a stable sentence chunk once the streamed text is long enough", () => {
    const text =
      "This is a fairly long first sentence that should be enough to begin speaking naturally once the model has clearly finished it. Here is a second sentence that keeps the answer moving.";

    const chunk = findStreamingTtsChunk(text, 0, false);

    expect(chunk).not.toBeNull();
    expect(chunk?.chunk).toBe(text);
    expect(text.slice(chunk?.nextConsumedChars ?? 0)).toBe("");
  });

  it("flushes the full remainder on the final pass", () => {
    expect(
      findStreamingTtsChunk(
        "Trailing partial answer without punctuation",
        0,
        true,
      ),
    ).toEqual({
      chunk: "Trailing partial answer without punctuation",
      nextConsumedChars: "Trailing partial answer without punctuation".length,
    });
  });
});
