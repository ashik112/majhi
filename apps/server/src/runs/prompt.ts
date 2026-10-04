import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PromptBlock } from "@majhi/acp";
import type { Attachment } from "@majhi/shared";
import { BRIEF_PROMPT, CONTEXT_PROMPT } from "../tasks/brief.ts";
import { DEPS_DROPPED_FILE } from "../tasks/folder-sweep.ts";

/** Images bigger than this are left out of the prompt. They stay in the task's attachments. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export interface PromptInput {
  /** The task folder. */
  folder: string;
  attachments: readonly Attachment[];
}

/** The first prompt of a task: read TASK.md, and the task's images as image blocks. */
export async function briefBlocks(input: PromptInput): Promise<PromptBlock[]> {
  return [{ type: "text", text: BRIEF_PROMPT }, ...(await imageBlocks(input))];
}

/** Heads the owner's newest message in a prompt: it wins over whatever came before. */
export const OWNER_LATEST =
  "The owner's latest instruction follows. It overrides earlier instructions, including what you were doing or waiting for. Say in your reply how you will follow it.";
/** Heads an owner message that the newest one follows up. */
export const OWNER_EARLIER = "An earlier owner message that you have not answered yet:";

/**
 * An owner message. Files are named by path in the text, images are sent as image blocks.
 * A session that has not seen the brief gets a line first pointing at TASK.md, except for
 * slash commands, which must stay whole.
 */
export async function ownerBlocks(
  input: PromptInput & { text: string; needsBrief: boolean; heading?: string | undefined },
): Promise<{ blocks: PromptBlock[]; briefSent: boolean }> {
  const files = input.attachments.filter((a) => a.kind === "file" && a.path !== undefined);
  let text = input.text.trim();
  if (files.length > 0) {
    const list = files.map((f) => `- ${join(input.folder, "attachments", f.path ?? f.name)}`).join("\n");
    text = `${text === "" ? "See the attached files." : text}\n\nAttached files:\n${list}`;
  }
  if (text === "") text = "See the attached images.";
  const slash = text.startsWith("/");
  const prefix = input.needsBrief && !slash;
  const headed = input.heading === undefined || slash ? text : `${input.heading}\n\n${text}`;
  return {
    blocks: [
      { type: "text", text: prefix ? `${CONTEXT_PROMPT}\n\n${headed}` : headed },
      ...(await imageBlocks(input)),
    ],
    briefSent: prefix,
  };
}

async function imageBlocks(input: PromptInput): Promise<PromptBlock[]> {
  const blocks: PromptBlock[] = [];
  for (const a of input.attachments) {
    if (a.kind !== "image" || a.path === undefined) continue;
    if (a.size !== undefined && a.size > IMAGE_MAX_BYTES) continue;
    try {
      const data = await readFile(join(input.folder, "attachments", a.path));
      if (data.byteLength <= IMAGE_MAX_BYTES) {
        blocks.push({ type: "image", mime: a.mime ?? "image/png", data: data.toString("base64") });
      }
    } catch {
      // A missing image file is not worth stopping the turn.
    }
  }
  return blocks;
}

/**
 * The line an agent gets once after majhi removed the task's dependency folders to free disk (the
 * sweep leaves a marker). Reading it deletes the marker. Undefined when nothing was removed.
 */
export async function takeDepsNote(folder: string): Promise<string | undefined> {
  const marker = join(folder, DEPS_DROPPED_FILE);
  let removed: string;
  try {
    removed = await readFile(marker, "utf8");
  } catch {
    return undefined;
  }
  await rm(marker, { force: true });
  const list = removed
    .split("\n")
    .filter((l) => l !== "")
    .join(", ");
  return `majhi removed dependency folders to free disk (${list}). Run the project's install command before you build or test.`;
}
