import { Readable, Writable } from "node:stream";
import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { OptionValue } from "@majhi/shared";
import { ExitCause } from "./exit-cause.ts";
import type { AccountRuntime, Command, RuntimeOptions } from "./index.ts";
import { startTool, type ToolProcess } from "./tool-process.ts";

export interface SessionOptions {
  models: OptionValue[];
  efforts: OptionValue[];
  defaultModel?: string;
  defaultEffort?: string;
}

export class AcpAuthRequired extends Error {}

const AUTH_REQUIRED = -32000;

/** A client that grants nothing: probes never send a prompt, so nothing should ask. */
const denyingClient: Client = {
  requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
  sessionUpdate: () => {},
  readTextFile: () => {
    throw new Error("File access is not available");
  },
  writeTextFile: () => {
    throw new Error("File access is not available");
  },
  createTerminal: () => {
    throw new Error("Terminals are not available");
  },
};

/**
 * Starts the adapter, opens one ACP session in a fresh temp dir and returns the
 * model and effort options. Sends no prompt. Always kills the process.
 * Throws `AcpAuthRequired` when the agent asks for auth, or an Error with a plain message.
 */
export async function readSessionOptions(
  options: Pick<RuntimeOptions, "spawner">,
  account: AccountRuntime,
  adapter: Command,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SessionOptions> {
  let tool: ToolProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    tool = await startTool(options, account, adapter, env);
    const proc = tool.child;
    const cwd = tool.cwd;
    const cause = new ExitCause();
    proc.stderr?.on("data", (d: Buffer) => cause.push(d.toString()));
    const died = new Promise<never>((_, reject) => {
      proc.on("error", (err: NodeJS.ErrnoException) =>
        reject(new Error(err.code === "ENOENT" ? `Command not found: ${adapter.command}` : err.message)),
      );
      proc.on("close", (code) => {
        const tail = cause.line();
        reject(new Error(`Agent exited with code ${code}${tail ? `: ${tail}` : ""}`));
      });
    });
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
    });

    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin as Writable) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout as Readable) as ReadableStream<Uint8Array>,
    );
    const conn = new ClientSideConnection(() => denyingClient, stream);

    const work = (async () => {
      await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const session = await conn.newSession({ cwd, mcpServers: [] });
      return extractOptions(session.configOptions ?? []);
    })().catch((err: unknown) => {
      if (isAuthRequired(err)) throw new AcpAuthRequired("Sign-in required");
      throw err instanceof Error ? err : new Error(String(err));
    });
    // The loser of the race must not become an unhandled rejection.
    work.catch(() => {});
    died.catch(() => {});
    return await Promise.race([work, died, timedOut]);
  } finally {
    clearTimeout(timer);
    await tool?.close();
  }
}

export function isAuthRequired(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === AUTH_REQUIRED;
}

function selectValues(option: SessionConfigOption): OptionValue[] {
  if (option.type !== "select") return [];
  const out: OptionValue[] = [];
  for (const item of option.options) {
    const entries = "options" in item ? item.options : [item];
    for (const e of entries) {
      out.push(
        e.description
          ? { id: e.value, name: e.name, description: e.description }
          : { id: e.value, name: e.name },
      );
    }
  }
  return out;
}

function currentValue(option: SessionConfigOption | undefined): string | undefined {
  return option?.type === "select" ? option.currentValue : undefined;
}

export function extractOptions(options: SessionConfigOption[]): SessionOptions {
  const model = options.find((o) => o.category === "model");
  const effort = options.find((o) => o.category === "thought_level");
  const result: SessionOptions = {
    models: model ? selectValues(model) : [],
    efforts: effort ? selectValues(effort) : [],
  };
  const dm = currentValue(model);
  const de = currentValue(effort);
  if (dm) result.defaultModel = dm;
  if (de) result.defaultEffort = de;
  return result;
}
