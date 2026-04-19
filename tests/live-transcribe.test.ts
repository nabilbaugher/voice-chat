import { describe, expect, it } from "vitest";

import { applyTranscriptUpdate, getTranscriptText } from "../server/live-transcribe.js";

describe("Deepgram transcript accumulation", () => {
  it("keeps interim text alongside finalized segments", () => {
    const first = applyTranscriptUpdate(
      { finalized: [], interim: "" },
      "I want to talk for a while",
      true,
    );
    const second = applyTranscriptUpdate(first, "and keep going", false);

    expect(getTranscriptText(second)).toBe("I want to talk for a while and keep going");
  });

  it("deduplicates repeated final segments", () => {
    const first = applyTranscriptUpdate(
      { finalized: ["I want to talk for a while"], interim: "and keep going" },
      "and keep going",
      true,
    );
    const second = applyTranscriptUpdate(first, "and keep going", true);

    expect(getTranscriptText(second)).toBe("I want to talk for a while and keep going");
  });
});
