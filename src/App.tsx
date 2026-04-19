import { useEffect, useReducer, useRef, useState } from "react";
import { MicVAD } from "@ricky0123/vad-web";
import ortWasmModuleUrl from "./vendor/ort/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasmBinaryUrl from "./vendor/ort/ort-wasm-simd-threaded.jsep.wasm?url";

import type { ConversationTurn } from "../shared/contracts";
import {
  endSession,
  fetchContextFiles,
  fetchTtsAudio,
  startSession,
  streamReply,
  transcribeAudio,
} from "./lib/api";
import { AudioController } from "./lib/audio-controller";
import {
  matchesFinishPhrase,
  stripTrailingFinishPhrase,
} from "./lib/finish-phrase";
import { LiveTranscriptionController } from "./lib/live-transcription";
import { pcmToWavBlob } from "./lib/audio-utils";
import { playListeningChime, playThinkingChime } from "./lib/chime";
import { findStreamingTtsChunk } from "./lib/streaming-tts";
import {
  finalizeSavedTranscriptSession,
  getSavedTranscriptSessions,
  type SavedTranscriptSession,
  upsertSavedTranscriptSession,
} from "./lib/transcript-storage";
import { releaseWakeLock, requestWakeLock } from "./lib/wake-lock";
import { getStatusCopy, initialState, voiceAppReducer } from "./state/machine";

const TTS_SPEED_OPTIONS = [
  { label: "1x", value: 1 },
  { label: "1.25x", value: 1.25 },
  { label: "1.5x", value: 1.5 },
  { label: "2x", value: 2 },
] as const;
const TURN_MODE_OPTIONS = [
  { label: "Auto", value: "auto" },
  { label: "Tap When Done", value: "manual" },
] as const;

type TurnMode = (typeof TURN_MODE_OPTIONS)[number]["value"];

export default function App() {
  const [state, dispatch] = useReducer(voiceAppReducer, initialState);
  const [ttsSpeed, setTtsSpeed] = useState<number>(1);
  const [turnMode, setTurnMode] = useState<TurnMode>("auto");
  const [isManualRecording, setIsManualRecording] = useState(false);
  const [availableContextFiles, setAvailableContextFiles] = useState<string[]>([]);
  const [selectedContextFiles, setSelectedContextFiles] = useState<string[]>([]);
  const [selectedSavedSessionIds, setSelectedSavedSessionIds] = useState<string[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedTranscriptSession[]>([]);
  const [showSavedSessions, setShowSavedSessions] = useState(false);
  const [finishPhrase, setFinishPhrase] = useState("done talking");
  const [finishPhraseEnabled, setFinishPhraseEnabled] = useState(true);
  const [finishPhraseNotice, setFinishPhraseNotice] = useState<string | null>(
    null,
  );
  const vadRef = useRef<MicVAD | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const audioControllerRef = useRef(new AudioController());
  const liveTranscriptionRef = useRef<LiveTranscriptionController | null>(null);
  const manualTurnClosingRef = useRef(false);
  const runTokenRef = useRef(0);
  const destroyedRef = useRef(false);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    setSavedSessions(getSavedTranscriptSessions());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { filenames } = await fetchContextFiles();
        setAvailableContextFiles(filenames);
        setSelectedContextFiles(filenames);
      } catch (error) {
        dispatch({
          type: "ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Unable to load context files.",
        });
      }
    })();
  }, []);

  useEffect(() => {
    if (!state.sessionId || state.turns.length === 0) {
      return;
    }

    setSavedSessions(
      upsertSavedTranscriptSession({
        id: state.sessionId,
        startedAt:
          getSavedTranscriptSessions().find((session) => session.id === state.sessionId)
            ?.startedAt ?? new Date().toISOString(),
        endedAt: null,
        contextFileCount: state.contextFileCount,
        turns: state.turns,
      }),
    );
  }, [state.contextFileCount, state.sessionId, state.turns]);

  useEffect(() => {
    destroyedRef.current = false;

    return () => {
      destroyedRef.current = true;
      audioControllerRef.current.stop();
      stopManualRecordingSession();
      vadRef.current?.destroy();
      void releaseWakeLock(wakeLockRef.current);
    };
  }, []);

  async function handleStart() {
    if (state.status !== "IDLE" && state.status !== "ERROR") {
      return;
    }

    dispatch({ type: "RESET_ERROR" });
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;

    try {
      const [{ sessionId, contextFileCount }, wakeLock] = await Promise.all([
        startSession({
          contextFilenames: selectedContextFiles,
          previousConversations: savedSessions
            .filter((session) => selectedSavedSessionIds.includes(session.id))
            .map((session) => ({
              id: session.id,
              startedAt: session.startedAt,
              turns: session.turns.map((turn) => ({
                role: turn.role,
                text: turn.text,
                kind: turn.kind,
              })),
            })),
        }),
        requestWakeLock(),
      ]);

      if (destroyedRef.current || runToken !== runTokenRef.current) {
        await endSession(sessionId).catch(() => undefined);
        return;
      }

      wakeLockRef.current = wakeLock;
      await audioControllerRef.current.unlock();
      if (turnMode === "auto") {
        const vad = await MicVAD.new({
          model: "v5",
          baseAssetPath: "/vad/",
          onnxWASMBasePath: "/vad/",
          ortConfig: (ort) => {
            ort.env.wasm.wasmPaths = {
              mjs: ortWasmModuleUrl,
              wasm: ortWasmBinaryUrl,
            };
          },
          positiveSpeechThreshold: 0.32,
          negativeSpeechThreshold: 0.16,
          minSpeechMs: 300,
          redemptionMs: 1800,
          preSpeechPadMs: 700,
          onSpeechEnd: async (audio) => {
            await processAudioUtterance(
              sessionId,
              pcmToWavBlob(audio),
              runToken,
            );
          },
        });

        if (destroyedRef.current || runToken !== runTokenRef.current) {
          vad.destroy();
          await endSession(sessionId).catch(() => undefined);
          return;
        }

        vadRef.current = vad;
        await vad.start();
        void playListeningChime();
      } else {
        dispatch({ type: "SESSION_STARTED", sessionId, contextFileCount });
        await startManualRecording(sessionId, runToken);
        return;
      }

      dispatch({ type: "SESSION_STARTED", sessionId, contextFileCount });
    } catch (error) {
      dispatch({
        type: "ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Unable to start the voice session.",
      });
    }
  }

  async function handleStop() {
    runTokenRef.current += 1;
    audioControllerRef.current.stop();
    stopManualRecordingSession();
    vadRef.current?.destroy();
    vadRef.current = null;

    const sessionId = stateRef.current.sessionId;
    if (sessionId) {
      if (stateRef.current.turns.length > 0) {
        setSavedSessions(
          finalizeSavedTranscriptSession(sessionId, new Date().toISOString()),
        );
      }
      await endSession(sessionId).catch(() => undefined);
    }

    await releaseWakeLock(wakeLockRef.current);
    wakeLockRef.current = null;
    dispatch({ type: "SESSION_STOPPED" });
  }

  async function restartListening() {
    if (turnMode === "manual") {
      const sessionId = stateRef.current.sessionId;
      if (!sessionId) {
        throw new Error("Session not found.");
      }

      await startManualRecording(sessionId, runTokenRef.current);
      return;
    }

    await vadRef.current?.start();
    void playListeningChime();
  }

  async function processAudioUtterance(
    sessionId: string,
    audioBlob: Blob,
    runToken: number,
  ) {
    if (
      runToken !== runTokenRef.current ||
      stateRef.current.status !== "LISTENING"
    ) {
      return;
    }

    const turnId = crypto.randomUUID();

    dispatch({ type: "TURN_STARTED", turnId });
    vadRef.current?.pause();

    try {
      const { transcript } = await transcribeAudio(sessionId, audioBlob);

      if (runToken !== runTokenRef.current) {
        return;
      }

      await continueTurnFromTranscript(
        sessionId,
        turnId,
        transcript.trim(),
        runToken,
      );
    } catch (error) {
      dispatch({
        type: "ERROR",
        message: error instanceof Error ? error.message : "The turn failed.",
      });
    }
  }

  async function continueTurnFromTranscript(
    sessionId: string,
    turnId: string,
    transcript: string,
    runToken: number,
  ) {
    if (!transcript.trim()) {
      dispatch({ type: "TRANSCRIPTION_SKIPPED", turnId });
      await restartListening();
      return;
    }

    dispatch({ type: "TRANSCRIPTION_READY", turnId, transcript });
    let activeThinkingTurnId: string | null = null;
    let answerTurnId: string | null = null;
    let finalReplyText = "";
    let hasPlayedThinkingChime = false;
    let queuedSpeechChars = 0;
    let streamedSpeechStarted = false;
    let playbackStarted = false;
    let speechQueue = Promise.resolve();

    const queueSpeechChunk = (text: string, assistantTurnId: string) => {
      const chunkText = text.trim();
      if (!chunkText) {
        return;
      }

      streamedSpeechStarted = true;
      const audioPromise = fetchTtsAudio({
        text: chunkText,
        speed: ttsSpeed,
      });

      speechQueue = speechQueue.then(async () => {
        const audioReply = await audioPromise;

        if (runToken !== runTokenRef.current) {
          return;
        }

        await audioControllerRef.current.playBlob(audioReply, {
          onStart: () => {
            if (playbackStarted) {
              return;
            }

            playbackStarted = true;
            dispatch({
              type: "PLAYBACK_STARTED",
              assistantTurnId,
              at: new Date().toISOString(),
            });
          },
        });
      });
    };

    await streamReply(sessionId, transcript, {
      onEvent: (event) => {
        if (runToken !== runTokenRef.current) {
          return;
        }

        switch (event.type) {
          case "thinking": {
            if (!hasPlayedThinkingChime) {
              hasPlayedThinkingChime = true;
              void playThinkingChime();
            }

            if (!activeThinkingTurnId) {
              activeThinkingTurnId = crypto.randomUUID();
              dispatch({
                type: "ASSISTANT_TURN_ADDED",
                turn: {
                  id: activeThinkingTurnId,
                  role: "assistant",
                  kind: "thinking",
                  text: event.text,
                  createdAt: new Date().toISOString(),
                  status: "pending",
                  interrupted: false,
                  playbackStartedAt: null,
                  playbackEndedAt: null,
                },
              });
            } else {
              dispatch({
                type: "ASSISTANT_TURN_UPDATED",
                turnId: activeThinkingTurnId,
                text: event.text,
              });
            }
            break;
          }

          case "thinking_complete": {
            if (activeThinkingTurnId) {
              dispatch({
                type: "ASSISTANT_TURN_COMPLETED",
                turnId: activeThinkingTurnId,
              });
              activeThinkingTurnId = null;
            }
            break;
          }

          case "answer": {
            if (!answerTurnId) {
              answerTurnId = crypto.randomUUID();
              dispatch({
                type: "ASSISTANT_TURN_ADDED",
                turn: {
                  id: answerTurnId,
                  role: "assistant",
                  kind: "answer",
                  text: event.text,
                  createdAt: new Date().toISOString(),
                  status: "pending",
                  interrupted: false,
                  playbackStartedAt: null,
                  playbackEndedAt: null,
                },
              });
            } else {
              dispatch({
                type: "ASSISTANT_TURN_UPDATED",
                turnId: answerTurnId,
                text: event.text,
              });
            }

            if (answerTurnId) {
              while (true) {
                const nextChunk = findStreamingTtsChunk(
                  event.text,
                  queuedSpeechChars,
                  false,
                );

                if (!nextChunk) {
                  break;
                }

                queuedSpeechChars = nextChunk.nextConsumedChars;
                queueSpeechChunk(nextChunk.chunk, answerTurnId);
              }
            }
            break;
          }

          case "done": {
            finalReplyText = event.replyText;
            break;
          }
        }
      },
    });

    if (runToken !== runTokenRef.current) {
      return;
    }

    if (!answerTurnId) {
      answerTurnId = crypto.randomUUID();
      dispatch({
        type: "ASSISTANT_TURN_ADDED",
        turn: {
          id: answerTurnId,
          role: "assistant",
          kind: "answer",
          text: finalReplyText,
          createdAt: new Date().toISOString(),
          status: "pending",
          interrupted: false,
          playbackStartedAt: null,
          playbackEndedAt: null,
        },
      });
    }

    const finalAnswerTurnId = answerTurnId;
    dispatch({
      type: "ASSISTANT_TURN_COMPLETED",
      turnId: finalAnswerTurnId,
    });

    if (runToken !== runTokenRef.current) {
      return;
    }

    if (!streamedSpeechStarted) {
      const audioReply = await fetchTtsAudio({
        text: finalReplyText,
        speed: ttsSpeed,
      });
      await audioControllerRef.current.playBlob(audioReply, {
        onStart: () => {
          dispatch({
            type: "PLAYBACK_STARTED",
            assistantTurnId: finalAnswerTurnId,
            at: new Date().toISOString(),
          });
        },
      });
    } else {
      const finalChunk = findStreamingTtsChunk(
        finalReplyText,
        queuedSpeechChars,
        true,
      );
      if (finalChunk) {
        queuedSpeechChars = finalChunk.nextConsumedChars;
        queueSpeechChunk(finalChunk.chunk, finalAnswerTurnId);
      }

      await speechQueue;
    }

    dispatch({
      type: "PLAYBACK_ENDED",
      turnId,
      assistantTurnId: finalAnswerTurnId,
      at: new Date().toISOString(),
    });
    await restartListening();
  }

  async function startManualRecording(sessionId: string, runToken: number) {
    if (liveTranscriptionRef.current) {
      return;
    }

    stopManualRecordingSession();
    manualTurnClosingRef.current = false;

    const controller = new LiveTranscriptionController({
      sessionId,
      onTranscript: (text) => {
        if (
          runToken !== runTokenRef.current ||
          manualTurnClosingRef.current ||
          !finishPhraseEnabled ||
          !finishPhrase.trim()
        ) {
          return;
        }

        if (matchesFinishPhrase(text, finishPhrase)) {
          manualTurnClosingRef.current = true;
          setFinishPhraseNotice(
            `Heard "${finishPhrase}" and submitted the turn.`,
          );
          void finishManualTurn(finishPhrase);
        }
      },
      onError: (error) => {
        if (runToken !== runTokenRef.current || destroyedRef.current) {
          return;
        }

        dispatch({
          type: "ERROR",
          message: error.message,
        });
      },
    });

    liveTranscriptionRef.current = controller;

    try {
      await controller.start();
      void playListeningChime();
      setFinishPhraseNotice(
        finishPhraseEnabled && finishPhrase.trim()
          ? `Say "${finishPhrase}" to finish hands-free.`
          : "Tap Finish turn when you're done.",
      );
      setIsManualRecording(true);
    } catch (error) {
      liveTranscriptionRef.current = null;
      controller.stop();
      throw error;
    }
  }

  function stopManualRecordingSession() {
    liveTranscriptionRef.current?.stop();
    liveTranscriptionRef.current = null;
    manualTurnClosingRef.current = false;
    setIsManualRecording(false);
  }

  async function finishManualTurn(spokenFinishPhrase?: string) {
    const currentState = stateRef.current;
    if (
      turnMode !== "manual" ||
      currentState.status !== "LISTENING" ||
      !currentState.sessionId
    ) {
      return;
    }

    const controller = liveTranscriptionRef.current;
    if (!controller) {
      return;
    }

    manualTurnClosingRef.current = true;
    setIsManualRecording(false);

    try {
      const runToken = runTokenRef.current;
      const transcript = await controller.finalize();
      if (liveTranscriptionRef.current === controller) {
        liveTranscriptionRef.current = null;
      }

      if (
        runToken !== runTokenRef.current ||
        stateRef.current.status !== "LISTENING"
      ) {
        return;
      }

      const cleanedTranscript = spokenFinishPhrase
        ? stripTrailingFinishPhrase(transcript, spokenFinishPhrase)
        : transcript.trim();
      const turnId = crypto.randomUUID();

      dispatch({ type: "TURN_STARTED", turnId });
      await continueTurnFromTranscript(
        currentState.sessionId,
        turnId,
        cleanedTranscript,
        runToken,
      );
    } catch (error) {
      dispatch({
        type: "ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Unable to finish the recording.",
      });
    } finally {
      if (liveTranscriptionRef.current === controller) {
        liveTranscriptionRef.current = null;
      }
      manualTurnClosingRef.current = false;
    }
  }

  const isRunning = state.status !== "IDLE";
  const selectedSavedSessions = savedSessions.filter((session) =>
    selectedSavedSessionIds.includes(session.id),
  );
  const statusCopy =
    state.status === "LISTENING" && turnMode === "manual"
      ? finishPhraseEnabled && finishPhrase.trim()
        ? `Recording continuously. Say "${finishPhrase}" or tap finish.`
        : "Recording continuously until you tap finish."
      : getStatusCopy(state.status);
  const canFinishManualTurn =
    isRunning &&
    turnMode === "manual" &&
    state.status === "LISTENING" &&
    isManualRecording;

  return (
    <main className="min-h-screen px-5 py-6 text-ink sm:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl flex-col gap-8 lg:h-[calc(100vh-3rem)]">
        <section className="grid flex-1 gap-8 lg:min-h-0 lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
          <div className="relative overflow-hidden rounded-[2rem] border border-line bg-canvas/90 px-6 py-8 shadow-glow backdrop-blur lg:min-h-0 sm:px-8">
            <div className="absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-white/90 to-transparent" />
            <div className="relative flex h-full flex-col gap-8 overflow-y-auto pr-1">
              <header className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.34em] text-accent">
                  Voice Claude
                </p>
                <div className="max-w-xl space-y-3">
                  <h1 className="font-display text-4xl leading-none sm:text-5xl">
                    Voice notes with Claude.
                  </h1>
                  <p className="text-base leading-7 text-ink/68 sm:text-lg">
                    Start talking, end the turn automatically or with a finish
                    phrase, then hear the reply.
                  </p>
                </div>
              </header>

              <div className="grid gap-6 border-t border-line pt-6 sm:grid-cols-[auto_1fr] sm:items-end">
                <div className="flex flex-col gap-4">
                  <button
                    type="button"
                    onClick={isRunning ? handleStop : handleStart}
                    className="group inline-flex h-32 w-32 items-center justify-center rounded-full border border-accent/25 bg-accent text-xl font-semibold text-white transition duration-300 hover:-translate-y-1 hover:bg-[#8e5726] focus:outline-none focus:ring-4 focus:ring-accent/20"
                  >
                    <span
                      className={
                        state.status === "LISTENING" ? "animate-pulseSoft" : ""
                      }
                    >
                      {isRunning ? "Stop" : "Start"}
                    </span>
                  </button>
                  {turnMode === "manual" ? (
                    <button
                      type="button"
                      onClick={() => void finishManualTurn()}
                      disabled={!canFinishManualTurn}
                      className={[
                        "inline-flex h-12 items-center justify-center rounded-full border px-5 text-sm font-semibold transition",
                        canFinishManualTurn
                          ? "border-line bg-white text-ink hover:bg-sand"
                          : "cursor-not-allowed border-line/60 bg-white/60 text-ink/35",
                      ].join(" ")}
                    >
                      Finish turn
                    </button>
                  ) : null}
                  <p className="max-w-xs text-sm leading-6 text-ink/60">
                    {state.sessionId
                      ? `${state.contextFileCount} context file${state.contextFileCount === 1 ? "" : "s"} loaded for this session.`
                      : `${selectedContextFiles.length} context file${selectedContextFiles.length === 1 ? "" : "s"} selected.`}
                  </p>
                </div>

                <div className="space-y-5">
                  <div className="flex items-center gap-3">
                    <span
                      className={[
                        "h-3 w-3 rounded-full",
                        state.status === "LISTENING"
                          ? "animate-pulseSoft bg-pine"
                          : state.status === "ERROR"
                            ? "bg-red-500"
                            : "bg-accent",
                      ].join(" ")}
                    />
                    <p className="text-sm font-medium uppercase tracking-[0.28em] text-ink/55">
                      {state.status}
                    </p>
                  </div>
                  <p className="max-w-lg text-2xl font-display leading-tight">
                    {statusCopy}
                  </p>

                  {!isRunning ? (
                    <div className="border-t border-line pt-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink/45">
                        Start With
                      </p>

                      <div className="mt-4 space-y-4">
                        <div className="rounded-[1.25rem] border border-line bg-white/70 p-4">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink/45">
                                Context Files
                              </p>
                              <p className="mt-2 text-sm leading-6 text-ink/58">
                                Choose which markdown notes to inject before the chat starts.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setSelectedContextFiles(availableContextFiles)}
                              className="text-sm text-accent"
                            >
                              All
                            </button>
                          </div>

                          <div className="mt-4 max-h-48 space-y-2 overflow-y-auto pr-2">
                            {availableContextFiles.length === 0 ? (
                              <p className="text-sm leading-6 text-ink/50">
                                No context files found.
                              </p>
                            ) : (
                              availableContextFiles.map((filename) => (
                                <label
                                  key={filename}
                                  className="flex items-start gap-3 rounded-2xl border border-line/70 bg-white px-3 py-3 text-sm"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedContextFiles.includes(filename)}
                                    onChange={() =>
                                      setSelectedContextFiles((current) =>
                                        current.includes(filename)
                                          ? current.filter((entry) => entry !== filename)
                                          : [...current, filename].sort((left, right) =>
                                              left.localeCompare(right),
                                            ),
                                      )
                                    }
                                    className="mt-1 h-4 w-4 rounded border-line text-accent focus:ring-accent/30"
                                  />
                                  <span className="leading-6 text-ink/74">{filename}</span>
                                </label>
                              ))
                            )}
                          </div>
                        </div>

                        <div className="rounded-[1.25rem] border border-line bg-white/70 p-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink/45">
                            Previous Conversations
                          </p>
                          <p className="mt-2 text-sm leading-6 text-ink/58">
                            Optionally preload saved chats as reference context.
                          </p>

                          <div className="mt-4 max-h-56 space-y-3 overflow-y-auto pr-2">
                            {savedSessions.length === 0 ? (
                              <p className="text-sm leading-6 text-ink/50">
                                No saved conversations yet.
                              </p>
                            ) : (
                              savedSessions.map((session) => {
                                const previewTurn = session.turns.find(
                                  (turn) => turn.role === "user",
                                );

                                return (
                                  <label
                                    key={session.id}
                                    className="flex items-start gap-3 rounded-2xl border border-line/70 bg-white px-3 py-3 text-sm"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedSavedSessionIds.includes(session.id)}
                                      onChange={() =>
                                        setSelectedSavedSessionIds((current) =>
                                          current.includes(session.id)
                                            ? current.filter((entry) => entry !== session.id)
                                            : [...current, session.id],
                                        )
                                      }
                                      className="mt-1 h-4 w-4 rounded border-line text-accent focus:ring-accent/30"
                                    />
                                    <span className="min-w-0">
                                      <span className="block text-xs uppercase tracking-[0.2em] text-ink/45">
                                        {new Date(session.startedAt).toLocaleString()}
                                      </span>
                                      <span className="mt-1 block leading-6 text-ink/74">
                                        {previewTurn?.text ?? "Saved session"}
                                      </span>
                                    </span>
                                  </label>
                                );
                              })
                            )}
                          </div>

                          {selectedSavedSessions.length > 0 ? (
                            <p className="mt-3 text-sm leading-6 text-ink/55">
                              {selectedSavedSessions.length} prior conversation
                              {selectedSavedSessions.length === 1 ? "" : "s"} will be added as
                              reference context.
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="border-t border-line pt-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink/45">
                      Turn Ending
                    </p>
                    <div className="mt-3 inline-flex rounded-full border border-line bg-white/70 p-1">
                      {TURN_MODE_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          onClick={() => setTurnMode(option.value)}
                          disabled={isRunning}
                          className={[
                            "rounded-full px-4 py-2 text-sm transition",
                            turnMode === option.value
                              ? "bg-accent text-white"
                              : "text-ink/60 hover:bg-sand",
                            isRunning ? "cursor-not-allowed opacity-60" : "",
                          ].join(" ")}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-3 max-w-lg text-sm leading-6 text-ink/55">
                      {turnMode === "auto"
                        ? "Ends the turn after a pause."
                        : "Keeps recording until you finish manually or by phrase."}
                    </p>
                    {turnMode === "manual" ? (
                      <div className="mt-4 space-y-3 rounded-[1.25rem] border border-line bg-white/70 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink/45">
                              Hands-Free Finish
                            </p>
                            <p className="mt-2 max-w-md text-sm leading-6 text-ink/58">
                              Say a phrase to submit the turn.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setFinishPhraseEnabled((current) => !current)
                            }
                            disabled={isRunning}
                            className={[
                              "inline-flex h-10 min-w-24 items-center justify-center rounded-full border px-4 text-sm font-semibold transition",
                              finishPhraseEnabled
                                ? "border-accent/25 bg-accent text-white"
                                : "border-line bg-white text-ink/60",
                              isRunning ? "cursor-not-allowed opacity-60" : "",
                            ].join(" ")}
                          >
                            {finishPhraseEnabled ? "On" : "Off"}
                          </button>
                        </div>
                        <label className="block">
                          <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink/45">
                            Finish Phrase
                          </span>
                          <input
                            type="text"
                            value={finishPhrase}
                            onChange={(event) =>
                              setFinishPhrase(event.target.value)
                            }
                            disabled={isRunning || !finishPhraseEnabled}
                            className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-base text-ink outline-none transition placeholder:text-ink/30 focus:border-accent/50"
                            placeholder="done talking"
                          />
                        </label>
                        <p className="text-sm leading-6 text-ink/55">
                          {finishPhraseNotice ??
                            "Use something distinctive so it does not trigger accidentally."}
                        </p>
                      </div>
                    ) : null}
                  </div>

                  <div className="border-t border-line pt-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink/45">
                      Voice Pace
                    </p>
                    <div className="mt-3 inline-flex rounded-full border border-line bg-white/70 p-1">
                      {TTS_SPEED_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          onClick={() => setTtsSpeed(option.value)}
                          className={[
                            "rounded-full px-4 py-2 text-sm transition",
                            ttsSpeed === option.value
                              ? "bg-accent text-white"
                              : "text-ink/60 hover:bg-sand",
                          ].join(" ")}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <section className="flex flex-col rounded-[2rem] border border-line bg-white/80 p-6 backdrop-blur lg:min-h-0 lg:overflow-hidden sm:p-7">
            <div className="flex items-end justify-between gap-4 border-b border-line pb-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-accent">
                  Session Transcript
                </p>
                <h2 className="mt-3 font-display text-3xl leading-none">
                  Current conversation
                </h2>
              </div>
              <p className="text-sm text-ink/55">{state.turns.length} turns</p>
            </div>

            <div className="mt-6 flex-1 space-y-4 overflow-y-auto pr-2 lg:min-h-0">
              {state.turns.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-sm uppercase tracking-[0.25em] text-ink/45">
                    Waiting
                  </p>
                  <p className="max-w-md text-base leading-7 text-ink/60">
                    Your turns and Claude&apos;s spoken replies appear here as
                    the session unfolds.
                  </p>
                </div>
              ) : (
                state.turns.map((turn) => (
                  <TranscriptRow key={turn.id} turn={turn} />
                ))
              )}
            </div>

            {state.error ? (
              <div className="mt-6 border-t border-line pt-5 text-sm text-red-700">
                <p className="font-semibold uppercase tracking-[0.24em]">
                  Error
                </p>
                <p className="mt-2 leading-6">{state.error}</p>
              </div>
            ) : null}

            <div className="mt-6 border-t border-line pt-5">
              <button
                type="button"
                onClick={() => setShowSavedSessions((current) => !current)}
                className="flex w-full items-center justify-between text-left"
              >
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.26em] text-accent">
                    Saved Locally
                  </p>
                  <p className="mt-2 text-sm leading-6 text-ink/58">
                    {savedSessions.length === 0
                      ? "No saved sessions yet."
                      : `${savedSessions.length} saved session${savedSessions.length === 1 ? "" : "s"} in this browser.`}
                  </p>
                </div>
                <span className="text-sm text-ink/45">
                  {showSavedSessions ? "Hide" : "Show"}
                </span>
              </button>

              {showSavedSessions && savedSessions.length > 0 ? (
                <div className="mt-4 max-h-72 space-y-3 overflow-y-auto pr-2">
                  {savedSessions.map((session) => (
                    <SavedSessionCard key={session.id} session={session} />
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink/45">
        {label}
      </p>
      <p className="leading-6 text-ink/70">{value}</p>
    </div>
  );
}

function TranscriptRow({ turn }: { turn: ConversationTurn }) {
  const isAssistant = turn.role === "assistant";
  const isThinking = turn.kind === "thinking";

  return (
    <article className="border-b border-line/80 pb-4 last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs font-semibold uppercase tracking-[0.26em] text-ink/45">
          {isAssistant ? (isThinking ? "Claude Thinking" : "Claude") : "You"}
        </p>
        <p className="text-xs text-ink/40">
          {new Date(turn.createdAt).toLocaleTimeString()}
        </p>
      </div>
      <p
        className={[
          "mt-3 text-[1.02rem] leading-7",
          isThinking ? "italic text-ink/62" : "text-ink/82",
        ].join(" ")}
      >
        {turn.text}
      </p>
      {isAssistant ? (
        <p className="mt-3 text-xs uppercase tracking-[0.22em] text-ink/40">
          {isThinking
            ? turn.status === "complete"
              ? "Thought surfaced"
              : "Thinking live"
            : turn.playbackStartedAt
              ? turn.playbackEndedAt
                ? "Played"
                : "Speaking"
              : "Queued"}
        </p>
      ) : null}
    </article>
  );
}

function SavedSessionCard({ session }: { session: SavedTranscriptSession }) {
  const previewTurn = session.turns.find((turn) => turn.role === "user");

  return (
    <details className="rounded-[1.25rem] border border-line bg-sand/55 p-4">
      <summary className="cursor-pointer list-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-ink/45">
              {new Date(session.startedAt).toLocaleString()}
            </p>
            <p className="mt-2 text-sm leading-6 text-ink/72">
              {previewTurn?.text ?? "No transcript preview available."}
            </p>
          </div>
          <p className="shrink-0 text-xs text-ink/45">
            {session.turns.length} turns
          </p>
        </div>
      </summary>

      <div className="mt-4 space-y-3 border-t border-line pt-4">
        {session.turns.map((turn) => (
          <div key={turn.id} className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ink/45">
              {turn.role === "assistant"
                ? turn.kind === "thinking"
                  ? "Claude Thinking"
                  : "Claude"
                : "You"}
            </p>
            <p className="text-sm leading-6 text-ink/78">{turn.text}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
