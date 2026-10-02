import {
  type ApiError,
  type CommandMeta,
  CommandMetaSchema,
  type CommandName,
  commands,
} from "@majhi/shared";
import type { z } from "zod";
import { ConfigConflictError } from "../config/write.ts";
import { errorMessage, formatIssues, UserError } from "../errors.ts";
import { HostJobError, HostOfflineError } from "../host/link.ts";
import type { CommandHandler, CommandHandlers, ParsedInput } from "./handlers.ts";

/** The `error` of a 503 answer: the command needs the host helper and none is connected. */
const HOST_OFFLINE_ERROR = "host-offline";

type Failure = { ok: false; status: 400 | 404 | 409 | 500 | 501 | 503; error: ApiError };
export type DispatchResult = { ok: true; output: unknown } | Failure;

export type Dispatch = (
  name: string,
  input: unknown,
  metaHeader: string | undefined,
) => Promise<DispatchResult>;

/**
 * Runs a command by name: checks the input and the meta header against their
 * schemas, runs the handler, and checks the output before it leaves.
 */
export function createDispatcher(
  handlers: CommandHandlers,
  /** Called after every command that is not a read and succeeded, so live channels can tell clients. */
  onChanged?: (name: CommandName) => void,
  /** Called before each command with its meta: the captain learns where the owner just acted (5.18). */
  observe?: (name: CommandName, input: unknown, meta: CommandMeta) => void,
): Dispatch {
  return async (name, input, metaHeader) => {
    if (!isCommandName(name)) {
      return { ok: false, status: 404, error: { error: `Unknown command: ${name}` } };
    }
    const meta = parseMeta(metaHeader);
    if (!meta.ok) return meta;
    observe?.(name, input, meta.meta);
    const result = await run(name, input, meta.meta, handlers);
    if (result.ok && commands[name].risk !== "read") onChanged?.(name);
    return result;
  };
}

function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(commands, name);
}

async function run<N extends CommandName>(
  name: N,
  rawInput: unknown,
  meta: CommandMeta,
  handlers: CommandHandlers,
): Promise<DispatchResult> {
  // Widened on purpose: TypeScript cannot follow the link between `name` and its
  // schema through the registry, so the parse result is typed again below.
  const inputSchema: z.ZodType = commands[name].input;
  const outputSchema: z.ZodType = commands[name].output;
  const handler: CommandHandler<N> = handlers[name];

  const input = inputSchema.safeParse(rawInput);
  if (!input.success) {
    return { ok: false, status: 400, error: { error: "Invalid input", details: formatIssues(input.error) } };
  }

  let output: unknown;
  try {
    output = await handler(input.data as ParsedInput<N>, { command: name, meta });
  } catch (err) {
    if (err instanceof ConfigConflictError) {
      const error: ApiError = { error: err.message };
      if (err.details.length > 0) error.details = err.details;
      return { ok: false, status: 409, error };
    }
    if (err instanceof UserError) {
      const error: ApiError = { error: err.message };
      if (err.details.length > 0) error.details = err.details;
      return { ok: false, status: err.status, error };
    }
    if (err instanceof HostOfflineError) {
      return { ok: false, status: 503, error: { error: HOST_OFFLINE_ERROR, details: [err.message] } };
    }
    if (err instanceof HostJobError) return { ok: false, status: 400, error: { error: err.message } };
    return { ok: false, status: 500, error: { error: `${name} failed: ${errorMessage(err)}` } };
  }

  const checked = outputSchema.safeParse(output);
  if (!checked.success) {
    return {
      ok: false,
      status: 500,
      error: { error: `${name} returned an invalid result`, details: formatIssues(checked.error) },
    };
  }
  return { ok: true, output: checked.data };
}

function parseMeta(header: string | undefined): { ok: true; meta: CommandMeta } | Failure {
  let raw: unknown = {};
  if (header !== undefined && header.trim() !== "") {
    try {
      raw = JSON.parse(header);
    } catch {
      return { ok: false, status: 400, error: { error: "The x-majhi-meta header is not valid JSON" } };
    }
  }
  const meta = CommandMetaSchema.safeParse(raw);
  if (!meta.success) {
    return {
      ok: false,
      status: 400,
      error: { error: "Invalid x-majhi-meta header", details: formatIssues(meta.error) },
    };
  }
  return { ok: true, meta: meta.data };
}
