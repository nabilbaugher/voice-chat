import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { PreviousConversationContext } from "../shared/contracts.js";

export interface LoadedContextBundle {
  fileCount: number;
  filenames: string[];
  systemPrompt: string;
}

const PROMPT_PREAMBLE = [
  "You are Claude, acting as a thoughtful voice-based thinking partner.",
  "Be reflective, precise, and collaborative rather than breezy or assistant-like.",
  "The user is likely walking and listening through headphones, so keep spoken answers clear and well-structured.",
  "This is a live voice conversation, so default to brief, conversational responses that sound natural out loud.",
  "Keep most replies to a few sentences unless the user explicitly asks for a deeper explanation.",
  "Avoid long listicles, long preambles, and exhaustive caveats unless depth is specifically requested or clearly necessary.",
  "Prefer a natural spoken cadence over heavily formatted output.",
  "Avoid code snippets, pseudo-code, or implementation detail dumps unless the user explicitly asks for them.",
  "Use the provided project context when it is relevant, but do not cite internal notes unless asked."
].join("\n");

export async function listContextFiles(
  contextDir = path.resolve(process.cwd(), "context")
): Promise<string[]> {
  try {
    return (await readdir(contextDir))
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }

    return [];
  }
}

export async function loadContextBundle(
  contextDir = path.resolve(process.cwd(), "context"),
  options: {
    previousConversations?: PreviousConversationContext[];
    selectedFilenames?: string[];
  } = {}
): Promise<LoadedContextBundle> {
  const availableFilenames = await listContextFiles(contextDir);
  const selectedSet =
    options.selectedFilenames === undefined
      ? null
      : new Set(options.selectedFilenames);
  const filenames =
    selectedSet === null
      ? availableFilenames
      : availableFilenames.filter((filename) => selectedSet.has(filename));

  const sections = await Promise.all(
    filenames.map(async (filename) => {
      const absolutePath = path.join(contextDir, filename);
      const content = await readFile(absolutePath, "utf8");
      return `# ${filename}\n\n${content.trim()}`;
    })
  );

  const contextBlock =
    sections.length > 0
      ? `Project context follows.\n\n${sections.join("\n\n---\n\n")}`
      : "No project context files were provided for this session.";

  const previousConversations =
    options.previousConversations?.filter(
      (conversation) => conversation.turns.length > 0
    ) ?? [];
  const previousConversationBlock =
    previousConversations.length > 0
      ? [
          "Selected prior conversation context follows. These are reference transcripts from earlier sessions, not the current live turn history.",
          previousConversations
            .map((conversation, index) => {
              const header = `## Prior conversation ${index + 1} (${conversation.startedAt})`;
              const transcript = conversation.turns
                .map((turn) => {
                  const speaker =
                    turn.role === "assistant"
                      ? turn.kind === "thinking"
                        ? "Claude Thinking"
                        : "Claude"
                      : "User";
                  return `${speaker}: ${turn.text.trim()}`;
                })
                .join("\n");
              return `${header}\n${transcript}`;
            })
            .join("\n\n---\n\n")
        ].join("\n\n")
      : "No prior conversation context was selected for this session.";

  return {
    fileCount: filenames.length,
    filenames,
    systemPrompt: `${PROMPT_PREAMBLE}\n\n${contextBlock}\n\n${previousConversationBlock}`.trim()
  };
}
