const MIN_STREAMING_TTS_CHARS = 140;
const TARGET_STREAMING_TTS_CHARS = 240;
const MAX_STREAMING_TTS_CHARS = 360;

export interface StreamingTtsChunk {
  chunk: string;
  nextConsumedChars: number;
}

export function findStreamingTtsChunk(
  text: string,
  consumedChars: number,
  isFinal: boolean,
): StreamingTtsChunk | null {
  const remaining = text.slice(consumedChars);
  if (!remaining.trim()) {
    return null;
  }

  if (isFinal) {
    return {
      chunk: remaining.trim(),
      nextConsumedChars: text.length,
    };
  }

  const sentenceBoundaries = Array.from(
    remaining.matchAll(/[.!?](?=\s|$)/g),
    (match) => (match.index ?? 0) + 1,
  );

  if (sentenceBoundaries.length === 0) {
    return null;
  }

  const boundary =
    sentenceBoundaries.find(
      (index) =>
        index >= TARGET_STREAMING_TTS_CHARS &&
        index <= MAX_STREAMING_TTS_CHARS,
    ) ??
    [...sentenceBoundaries].reverse().find((index) => index <= MAX_STREAMING_TTS_CHARS) ??
    sentenceBoundaries[0];

  if (
    boundary < MIN_STREAMING_TTS_CHARS &&
    sentenceBoundaries.length < 2 &&
    remaining.length < TARGET_STREAMING_TTS_CHARS
  ) {
    return null;
  }

  let nextConsumedChars = consumedChars + boundary;
  while (nextConsumedChars < text.length && /\s/.test(text[nextConsumedChars] ?? "")) {
    nextConsumedChars += 1;
  }

  return {
    chunk: remaining.slice(0, boundary).trim(),
    nextConsumedChars,
  };
}
