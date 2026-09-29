import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptBlock } from "@majhi/acp";
import type { Attachment } from "@majhi/shared";
import { BRIEF_PROMPT, CONTEXT_PROMPT } from "../tasks/brief.ts";

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

/**
 * An owner message. Files are named by path in the text, images are sent as image blocks.
 * A session that has not seen the brief gets a line first pointing at TASK.md, except for
 * slash commands, which must stay whole.
 */
export async function ownerBlocks(
  input: PromptInput & { text: string; needsBrief: boolean },
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
  return {
    blocks: [
      { type: "text", text: prefix ? `${CONTEXT_PROMPT}\n\n${text}` : text },
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
