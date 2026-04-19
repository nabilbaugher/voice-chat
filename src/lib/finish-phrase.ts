export function normalizeVoiceFinishText(text: string) {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesFinishPhrase(transcript: string, phrase: string) {
  const normalizedTranscript = normalizeVoiceFinishText(transcript);
  const normalizedPhrase = normalizeVoiceFinishText(phrase);

  if (!normalizedTranscript || !normalizedPhrase) {
    return false;
  }

  return (
    normalizedTranscript === normalizedPhrase ||
    normalizedTranscript.endsWith(` ${normalizedPhrase}`) ||
    normalizedTranscript.includes(` ${normalizedPhrase} `)
  );
}

export function stripTrailingFinishPhrase(transcript: string, phrase: string) {
  const normalizedPhrase = normalizeVoiceFinishText(phrase);
  if (!normalizedPhrase) {
    return transcript.trim();
  }

  const collapsedTranscript = transcript.replace(/\s+/g, " ").trim();
  const normalizedTranscript = normalizeVoiceFinishText(collapsedTranscript);
  if (!normalizedTranscript.endsWith(normalizedPhrase)) {
    return collapsedTranscript;
  }

  const phraseWords = normalizedPhrase.split(" ").length;
  const transcriptWords = collapsedTranscript.split(" ");
  if (transcriptWords.length <= phraseWords) {
    return "";
  }

  return transcriptWords.slice(0, transcriptWords.length - phraseWords).join(" ").trim();
}
