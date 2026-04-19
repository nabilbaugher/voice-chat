# VoiceDev — MVP Reference

## Motivation

The goal is to stay in a flow state during development. Constantly switching between coding, browsing, note-taking, and task management breaks focus. VoiceDev is an always-on voice interface that lets you control your computer and delegate work just by talking — while walking, thinking, or heads-down.

The core loop already exists: voice in, LLM thinks, responds. The MVP extends that loop with tools so it can _act_ on the computer, not just converse.

---

## Guiding Principles

- **Tight scope, general tools** — built for one workflow first, but each tool is general enough to extend naturally
- **Mac only** — no cross-platform complexity in the MVP
- **Files over infrastructure** — plain files on disk, no databases, no vector retrieval; upgrade later if needed
- **Always running, never in the way** — lives in the menubar

---

## Architecture

### The App

A lightweight Python menubar app, always running in the background. Activated by hotkey or click.

### The Loop

1. Voice in — captured and transcribed (Whisper)
2. Claude acts as the brain — interprets intent, routes to the right tool
3. Tool executes
4. Voice or text response back to user

### Tools

- File management (read, write, edit text files)
- Window and app control (AppleScript)
- Coding agent kickoff and status check

---

## Context Management

Two-layer system:

**Hot context** — a compressed summary of the current session. Lives in the active context window. Auto-compacts when token count gets long; can also be triggered manually by voice.

**Cold storage** — the full session transcript, append-only, written to disk from the very first message. Never deleted. The agent has bash tools and can grep or search this file naturally when it needs to reach back into history.

The compact step summarizes hot context down and appends the raw transcript to cold storage. No information is ever lost — just the resolution changes based on recency.

---

## Technical Notes

### Window & App Control

AppleScript via Python subprocess. Capabilities:

- Switch focus to any application by name (`activate application "Chrome"`)
- Open new browser tabs
- Navigate to a specific URL

For URL-aware commands like "open the app in the browser," the assistant infers the destination from session context (e.g. the known local dev server port or staging URL).

### Coding Agents

Kick off Claude Code or Codex runs by voice. Agents run in the background. A status-check tool lets the assistant summarize a running agent: what it has done, whether it is still running, whether it finished. Summary only in the MVP — no deep interactive control.

---

## Build Order

### 1. Context & Transcript Storage

Foundational — build first. Full transcript written to disk from message one. Auto-compact logic for the hot context window. Everything else depends on a coherent memory layer.

### 2. File Tools

Simplest tool surface. Read, write, and edit text files by voice. Immediately useful and exercises the file system from step one.

### 3. Window Control

Self-contained, no dependencies. AppleScript integration for app switching, tab opening, and URL navigation. This is the step where it starts feeling like real computer control.

### 4. Coding Agents

Most complex. Kickoff tool, background execution, status-check summary. Saved for last so simpler capabilities are solid before adding this layer.

---

## Definition of Done (MVP)

You can walk around, talk naturally, and the app:

- Remembers what you've been working on across a session
- Takes notes and manages files on command
- Switches focus to the right app or URL on command
- Kicks off a coding agent and reports back on its progress

No manual context re-explaining. No reaching for the keyboard for basic navigation. The computer keeps up with you.
