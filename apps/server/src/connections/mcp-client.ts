import type { Spawned } from "@majhi/acp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

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

/** A remote server over Streamable HTTP, with headers on every request. */
export function remoteTransport(url: string, headers: Record<string, string>): Transport {
  // The SDK's optional `sessionId` does not fit exactOptionalPropertyTypes; the shape is the same.
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  }) as unknown as Transport;
}

/** Connects, reads the names of the server's tools and closes. Throws with why it could not. */
export async function listTools(transport: Transport, timeoutMs: number): Promise<string[]> {
  const client = new Client({ name: "majhi-connection-test", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: timeoutMs,
      });
      names.push(...result.tools.map((t) => t.name));
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    return names;
  } finally {
    await client.close().catch(() => undefined);
  }
}
