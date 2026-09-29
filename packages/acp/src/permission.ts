import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { PermissionAsk } from "./session.ts";

const RawCommand = z.looseObject({
  command: z.union([z.string(), z.array(z.string())]).optional(),
  cmd: z.union([z.string(), z.array(z.string())]).optional(),
});

/** The command line of an execute tool call, from `rawInput` (Claude: string, Codex: argv array). */
export function commandOf(rawInput: unknown): string | undefined {
  const parsed = RawCommand.safeParse(rawInput);
  if (!parsed.success) return undefined;
  const c = parsed.data.command ?? parsed.data.cmd;
  const line = Array.isArray(c) ? c.join(" ") : c;
  return line?.trim() ? line : undefined;
}

/** Builds the ask handed to the permission handler. */
export function buildAsk(req: RequestPermissionRequest): PermissionAsk {
  const tc = req.toolCall;
  const ask: PermissionAsk = {
    title: tc.title || tc.name || "Permission needed",
    options: req.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
  };
  if (tc.toolCallId) ask.toolCallId = tc.toolCallId;
  if (tc.kind) ask.kind = tc.kind;
  if (tc.kind === "execute") {
    const command = commandOf(tc.rawInput);
    if (command) ask.command = command;
  }
  return ask;
}
