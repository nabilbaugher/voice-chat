import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listContextFiles, loadContextBundle } from "../server/context.js";

describe("loadContextBundle", () => {
  it("sorts markdown files and concatenates them into the prompt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "voice-chat-context-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "b-note.md"), "Second file");
    await writeFile(path.join(dir, "a-note.md"), "First file");
    await writeFile(path.join(dir, "ignore.txt"), "ignored");

    const bundle = await loadContextBundle(dir);

    expect(bundle.fileCount).toBe(2);
    expect(bundle.filenames).toEqual(["a-note.md", "b-note.md"]);
    expect(bundle.systemPrompt.indexOf("# a-note.md")).toBeLessThan(
      bundle.systemPrompt.indexOf("# b-note.md")
    );
  });

  it("falls back cleanly when the folder does not exist", async () => {
    const bundle = await loadContextBundle(path.join(tmpdir(), "missing-context-folder"));

    expect(bundle.fileCount).toBe(0);
    expect(bundle.systemPrompt).toContain("No project context files were provided");
  });

  it("supports selecting specific context files and prior conversations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "voice-chat-context-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a-note.md"), "Alpha");
    await writeFile(path.join(dir, "b-note.md"), "Beta");

    const bundle = await loadContextBundle(dir, {
      selectedFilenames: ["b-note.md"],
      previousConversations: [
        {
          id: "saved-1",
          startedAt: "2026-04-19T12:00:00.000Z",
          turns: [
            { role: "user", text: "Earlier question" },
            { role: "assistant", text: "Earlier answer", kind: "answer" }
          ]
        }
      ]
    });

    expect(bundle.fileCount).toBe(1);
    expect(bundle.filenames).toEqual(["b-note.md"]);
    expect(bundle.systemPrompt).toContain("# b-note.md");
    expect(bundle.systemPrompt).not.toContain("# a-note.md");
    expect(bundle.systemPrompt).toContain("Selected prior conversation context follows");
    expect(bundle.systemPrompt).toContain("Earlier question");
    expect(bundle.systemPrompt).toContain("Earlier answer");
  });

  it("lists context files deterministically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "voice-chat-context-list-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "z-note.md"), "Zulu");
    await writeFile(path.join(dir, "a-note.md"), "Alpha");

    const filenames = await listContextFiles(dir);

    expect(filenames).toEqual(["a-note.md", "z-note.md"]);
  });
});
