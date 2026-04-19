import { describe, expect, it } from "vitest";

import {
  matchesFinishPhrase,
  normalizeVoiceFinishText,
  stripTrailingFinishPhrase,
} from "../src/lib/finish-phrase";

describe("finish phrase helpers", () => {
  it("normalizes punctuation and spacing", () => {
    expect(normalizeVoiceFinishText(" That's   IT! ")).toBe("thats it");
  });

  it("matches the finish phrase inside spoken text", () => {
    expect(matchesFinishPhrase("okay lets wrap it there", "wrap it there")).toBe(true);
    expect(matchesFinishPhrase("keep going for now", "wrap it there")).toBe(false);
  });

  it("strips the trailing finish phrase before sending the turn", () => {
    expect(stripTrailingFinishPhrase("Here is my actual thought wrap it there", "wrap it there")).toBe(
      "Here is my actual thought"
    );
    expect(stripTrailingFinishPhrase("wrap it there", "wrap it there")).toBe("");
  });
});
