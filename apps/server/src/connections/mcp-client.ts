import type { Spawned } from "@majhi/acp";
import type { ToolAnnotations } from "@majhi/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const ToolNamesSchema = z.object({
  // `annotations` is read apart, field by field: a server that sends one badly typed must not fail the list.
  tools: z.array(z.looseObject({ name: z.string(), annotations: z.unknown().optional() })),
  nextCursor: z.string().optional(),
});

/** A tool the server lists: its name and the hints it gives about it (MCP `Tool.annotations`). */
export interface ListedTool {
  name: string;
  annotations?: ToolAnnotations;
}

/** The hints of a tool's `annotations` that are booleans. The others (title, openWorldHint) are not kept. */
function readAnnotations(value: unknown): ToolAnnotations | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const given = value as Record<string, unknown>;
  const out: ToolAnnotations = {};
  if (typeof given.readOnlyHint === "boolean") out.readOnlyHint = given.readOnlyHint;
  if (typeof given.destructiveHint === "boolean") out.destructiveHint = given.destructiveHint;
  if (typeof given.idempotentHint === "boolean") out.idempotentHint = given.idempotentHint;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The hints of the listed tools that gave any, by tool name. Undefined when none did. */
export function annotationsOf(tools: readonly ListedTool[]): Record<string, ToolAnnotations> | undefined {
  const given = tools.flatMap((t) => (t.annotations === undefined ? [] : [[t.name, t.annotations] as const]));
  return given.length === 0 ? undefined : Object.fromEntries(given);
}

/** Pages of `tools/list` read at most. */
const MAX_PAGES = 10;

/**
 * An MCP client transport over a spawned server's stdin and stdout, so the server runs where the
 * spawner puts it (a runner container, or next to majhi) instead of where the SDK would.
 */
export class SpawnedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private readonly buffer = new ReadBuffer();
  /** The end of what the server wrote to stderr, to say why it stopped. */
  stderr = "";

  constructor(private readonly spawned: Spawned) {}

  async start(): Promise<void> {
    const { child } = this.spawned;
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (err) {
          // A line that is not JSON-RPC, like a log line on stdout. It is already consumed.
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    child.once("error", (err) => this.onerror?.(err));
    child.once("close", () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.spawned.child.stdin.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.spawned.kill();
  }
}

/** A remote server over Streamable HTTP, or SSE, with headers on every request. */
export function remoteTransport(
  url: string,
  headers: Record<string, string>,
  protocol: "http" | "sse" = "http",
): Transport {
  if (protocol === "sse") {
    // The stream and the POSTs both carry the headers. The SDK takes them in two places.
    return new SSEClientTransport(new URL(url), {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (input, init) => fetch(input, { ...init, headers: { ...headers, ...init?.headers } }),
      },
    });
  }
  // The SDK's optional `sessionId` does not fit exactOptionalPropertyTypes; the shape is the same.
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  }) as unknown as Transport;
}

/** Connects, reads the server's tools with their annotations and closes. Throws with why it could not. */
export async function listTools(transport: Transport, timeoutMs: number): Promise<ListedTool[]> {
  const client = new Client({ name: "majhi-connection-test", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const found: ListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Only the names and hints: a strict read of every tool's schemas fails the whole list on one
      // tool a server describes loosely (DigitalOcean's Networking and Functions do).
      const result = await client.request(
        { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
        ToolNamesSchema,
        { timeout: timeoutMs },
      );
      for (const t of result.tools) {
        const annotations = readAnnotations(t.annotations);
        found.push({ name: t.name, ...(annotations === undefined ? {} : { annotations }) });
      }
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    return found;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Connects, calls one tool and closes. The answer is the tool's structured content, or its first text
 * part that parses as JSON. Throws with why it could not. Only for reads the owner chose, like the ops
 * watch's error rate: majhi calls the tool named, with the arguments given, and uses one number from
 * the answer.
 */
export async function callTool(
  transport: Transport,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const client = new Client({ name: "majhi-ops-watch", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
    if (result.isError === true) throw new Error("the tool reported an error");
    if (result.structuredContent !== undefined) return result.structuredContent;
    const content = Array.isArray(result.content) ? result.content : [];
    for (const part of content) {
      if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") {
          try {
            return JSON.parse(text);
          } catch {
            // Not JSON: try the next part.
          }
        }
      }
    }
    throw new Error("the answer had no JSON");
  } finally {
    await client.close().catch(() => undefined);
  }
}
