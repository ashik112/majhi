import {
  ApiErrorSchema,
  type Attachment,
  AttachmentSchema,
  COMMAND_META_HEADER,
  type CommandInput,
  type CommandMetaSchema,
  type CommandName,
  type CommandOutput,
  commands,
  type Health,
  HealthSchema,
} from "@majhi/shared";
import type { z } from "zod";

/** Metadata the caller may attach; the server fills in defaults (actor: owner). */
export type CommandMetaInput = z.input<typeof CommandMetaSchema>;

/** The `error` a command answers with (HTTP 503) when it needs the host helper and none is connected. */
const HOST_OFFLINE_ERROR = "host-offline";

/** A command or health request that failed. `status` is 0 when the server could not be reached. */
export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";
  readonly status: number;
  readonly details: string[];
  readonly target: string;

  constructor(target: string, status: number, message: string, details: string[] = []) {
    super(message);
    this.target = target;
    this.status = status;
    this.details = details;
  }

  /** True when the request never got an answer from the server. */
  get unreachable(): boolean {
    return this.status === 0;
  }

  /** True when an `fs.*` command failed because no host helper is connected. */
  get hostOffline(): boolean {
    return this.status === 503 && this.message === HOST_OFFLINE_ERROR;
  }
}

/**
 * Runs a majhi command (SPEC 5.16): `POST /api/cmd/<name>` with the input as JSON.
 * The response is parsed with the command's output schema, errors with `ApiErrorSchema`.
 */
export async function cmd<N extends CommandName>(
  name: N,
  input: CommandInput<N>,
  meta?: CommandMetaInput,
): Promise<CommandOutput<N>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (meta) headers[COMMAND_META_HEADER] = JSON.stringify(meta);
  const body = await request(name, `/api/cmd/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  // TypeScript cannot correlate `commands[N]["output"]` with `CommandOutput<N>` for a generic N.
  // The value was parsed with exactly that command's output schema, so the cast is sound.
  const schema: z.ZodType = commands[name].output;
  return parseWith(name, schema, body) as CommandOutput<N>;
}

/** Reads `GET /health`. `signal` lets a caller give up on a server that accepts but never answers. */
export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const body = await request("health", "/health", {
    method: "GET",
    cache: "no-store",
    signal: signal ?? null,
  });
  return parseWith("health", HealthSchema, body);
}

/** `POST /api/uploads`: stores one file for a task being written and answers with its attachment. */
export async function uploadFile(file: File): Promise<Attachment> {
  const form = new FormData();
  form.append("file", file, file.name);
  const body = await request("uploads", "/api/uploads", { method: "POST", body: form });
  return parseWith("uploads", AttachmentSchema, body);
}

async function request(target: string, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ApiRequestError(target, 0, "majhi is not responding", [reason]);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new ApiRequestError(target, res.status, `Expected JSON from ${url}, got something else`, [
      text.slice(0, 200),
    ]);
  }

  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiRequestError(target, res.status, parsed.data.error, parsed.data.details ?? []);
    }
    throw new ApiRequestError(target, res.status, `${url} failed with HTTP ${res.status}`);
  }
  return body;
}

function parseWith<T>(target: string, schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ApiRequestError(
    target,
    200,
    `The server answered ${target} in an unexpected shape`,
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  );
}
