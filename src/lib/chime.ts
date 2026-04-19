async function playChime(input: {
  startFrequency: number;
  endFrequency: number;
  attackGain: number;
  durationSeconds: number;
}) {
  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextClass) {
    return;
  }

  const context = new AudioContextClass();
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(input.startFrequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(
    input.endFrequency,
    now + input.durationSeconds * 0.6,
  );

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(input.attackGain, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + input.durationSeconds);

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(now);
  oscillator.stop(now + input.durationSeconds + 0.02);

  await new Promise<void>((resolve) => {
    oscillator.onended = () => resolve();
  });

  await context.close().catch(() => undefined);
}

export async function playThinkingChime() {
  await playChime({
    startFrequency: 740,
    endFrequency: 1040,
    attackGain: 0.08,
    durationSeconds: 0.18,
  });
}

export async function playListeningChime() {
  await playChime({
    startFrequency: 520,
    endFrequency: 700,
    attackGain: 0.05,
    durationSeconds: 0.14,
  });
}
