# Voice Claude

Light-mode progressive web app for hands-free voice conversations with Claude while walking.

The app runs as a local-first stack:

- `src/` is the React + Vite + Tailwind PWA
- `server/` is the Express proxy for Whisper, Claude, and OpenAI TTS
- `context/` holds markdown notes that are loaded server-side at session start

## What It Does

The MVP loop is explicit and sequential:

1. Start a session
2. Listen continuously with browser VAD or record in `Tap When Done` mode
3. Convert each detected utterance to WAV
4. Transcribe with OpenAI Whisper
5. Send the transcript plus in-memory session history to Anthropic `claude-sonnet-4-6`
6. Speak the reply with OpenAI TTS, falling back to browser speech synthesis if needed
7. Resume listening

The frontend state machine stays in:

`IDLE -> LISTENING -> TRANSCRIBING -> THINKING -> SPEAKING -> LISTENING`

## Setup

Create a local environment file:

```bash
cp .env.example .env
```

Fill in:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPGRAM_API_KEY`

Optional server settings:

- `CLAUDE_MODEL`
- `CLAUDE_MAX_TOKENS`
- `CLAUDE_THINKING_BUDGET`
- `TTS_MODEL`
- `TTS_VOICE`
- `DEEPGRAM_STREAMING_MODEL`
- `DEEPGRAM_LANGUAGE`

Drop any markdown project notes into [`context/README.md`](/Users/nabilbaugher/development/experimentation/voice-chat/context/README.md) alongside additional `.md` files. Files are sorted by filename, concatenated, and injected into the Claude system prompt when a session starts.

## Commands

```bash
pnpm install
pnpm dev
pnpm test
pnpm check
pnpm build
```

Development starts:

- Vite frontend on `http://localhost:5173`
- Express API on `http://localhost:3001`

## Notes

- The interface is intentionally light-only.
- `Auto` turn ending uses browser VAD. `Tap When Done` streams live audio to Deepgram so you can speak through pauses and finish manually or with a spoken phrase.
- In `Tap When Done`, the spoken finish phrase is matched against Deepgram live transcripts and removed from the final transcript before Claude sees it.
- Claude web search is enabled on every chat turn, so fresh web results are available when the model decides they are useful.
- VAD assets are served from `public/vad/` so the app does not rely on a CDN.
- Interruption detection is not implemented yet, but the client stores playback timing hooks so barge-in support can be added later.
- Sessions are in-memory only. Stopping the app clears the active session.
