import {
  type CommandMeta,
  type ConnectionFailure,
  type ConnectMcpUrlInput,
  type ConnectTokenResult,
  failureFromError,
  failureFromHttp,
  type ProbeMcpInput,
  type ProbeMcpResult,
  suggestConnectionId,
} from "@majhi/shared";
import { listTools, remoteTransport } from "../connections/mcp-client.ts";
import { UserError } from "../errors.ts";
import { discover, type Fetch } from "./oauth.ts";
import { assertHostAllowed, bareHost, guardedFetch, type Lookup } from "./self-host.ts";

/**
 * An MCP server by address (SPEC 5.14, "MCP server by URL"). `probe` asks the server how it signs
 * in without saving anything: it sends `initialize` with no credential, and a 401 sends majhi to
 * the server's own sign-in metadata, where it reads whether the server lets a client register
 * itself. The answer is decided by the HTTP status and the metadata's fields, never by message text.
 * `connect` stores a header token and checks it with initialize and tools/list before it saves anything.
 *
 * The address is typed by the owner but the metadata it leads to is the server's, so every call goes
 * through `guardedFetch`: a private or metadata address is refused unless the owner confirmed it.
 */

export interface McpUrlDeps {
  fetch?: Fetch | undefined;
  lookup?: Lookup | undefined;
  /** Whether a host may serve a client metadata document as client ID. */
  clientMetadataUrl?: string | undefined;
  connections: {
    create(
      input: {
        org: string;
        id?: string;
        type: "mcp";
        name: string;
        description?: string;
        fields: Record<string, string>;
        headers?: Record<string, { kind: "secret" | "text"; value?: string }>;
      },
      command: string,
      meta: CommandMeta,
    ): Promise<unknown>;
    setSecret(
      input: { id: string; field: string; list: "headers"; value: string },
      command: string,
      meta: CommandMeta,
    ): Promise<unknown>;
    remove(id: string, command: string, meta: CommandMeta): Promise<unknown>;
  };
  connectionIds: () => Promise<{ id: string }[]>;
  orgExists: (org: string) => Promise<boolean>;
  /** The check of a stored connection: the one that decides it is connected. */
  check: (id: string) => Promise<{ ok: boolean; failure?: ConnectionFailure | undefined }>;
  health?: { start(id: string): unknown; remove(id: string): unknown } | undefined;
  changed: () => void;
}

const TIMEOUT_MS = 15_000;

/** The address as the owner means it: https, no sign-in inside, and a plain host. */
export function mcpAddress(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new UserError("That is not a web address. Use one like https://mcp.acme.test/mcp.");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new UserError("An MCP server's address starts with https://.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UserError("Leave the sign-in out of the address. Paste the token in its own field.");
  }
  return url;
}

export class McpUrlService {
  constructor(private readonly deps: McpUrlDeps) {}

  private guard(url: URL, allowPrivate: boolean): Fetch {
    return guardedFetch(
      this.deps.fetch ?? fetch,
      (host) => allowPrivate && bareHost(host) === url.hostname,
      this.deps.lookup,
    );
  }

  async probe(input: ProbeMcpInput): Promise<ProbeMcpResult> {
    const allowPrivate = input.allowPrivate === true;
    // An address majhi will not call is an answer, with the exact reason, not a failure of the page.
    let url: URL;
    try {
      url = mcpAddress(input.url, allowPrivate);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return { method: "unreachable", url: input.url, failure: { reason: "blocked-host", fix: err.message } };
    }
    try {
      await assertHostAllowed(url.host, {
        allowPrivate,
        ...(this.deps.lookup === undefined ? {} : { lookup: this.deps.lookup }),
      });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return { method: "unreachable", url: input.url, failure: { reason: "blocked-host", fix: err.message } };
    }
    const fetchFn = this.guard(url, allowPrivate);
    const address = url.toString();
    let status: number;
    try {
      const res = await fetchFn(address, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "majhi", version: "1" },
          },
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      return { method: "unreachable", url: address, failure: { reason: failureFromError(err) } };
    }
    if (status >= 200 && status < 300) return { method: "open", url: address };
    if (status !== 401) {
      return {
        method: "unreachable",
        url: address,
        failure: { reason: failureFromHttp(status) ?? "unexpected", status },
      };
    }
    // It wants a credential. Does it say how to sign in, and does it let majhi register itself?
    try {
      const found = await discover(address, fetchFn);
      const metadata = found.metadata as { client_id_metadata_document_supported?: unknown };
      if (
        metadata.client_id_metadata_document_supported === true &&
        this.deps.clientMetadataUrl !== undefined
      ) {
        return { method: "oauth", url: address, issuer: found.issuer, registration: "metadata-document" };
      }
      if (found.metadata.registration_endpoint !== undefined) {
        return { method: "oauth", url: address, issuer: found.issuer, registration: "dynamic" };
      }
      return { method: "oauth-needs-app", url: address, issuer: found.issuer };
    } catch {
      // It names no sign-in of its own, so it takes a token in a header.
      return { method: "token", url: address };
    }
  }

  /** Connects a server with a header token or no sign-in. Nothing is saved when the check fails. */
  async connect(input: ConnectMcpUrlInput, meta: CommandMeta): Promise<ConnectTokenResult> {
    const allowPrivate = input.allowPrivate === true;
    const url = mcpAddress(input.url, allowPrivate);
    if (!(await this.deps.orgExists(input.org)))
      throw new UserError(`Org "${input.org}" does not exist.`, 404);
    await assertHostAllowed(url.host, {
      allowPrivate,
      ...(this.deps.lookup === undefined ? {} : { lookup: this.deps.lookup }),
    });
    const header = input.header ?? "Authorization";
    const value =
      input.token === undefined
        ? undefined
        : header === "Authorization"
          ? `Bearer ${input.token}`
          : input.token;
    const address = url.toString();
    // The check first, with the token in memory only: a wrong one saves nothing.
    try {
      await listTools(
        remoteTransport(address, value === undefined ? {} : { [header]: value }, "http"),
        30_000,
      );
    } catch (err) {
      const reason = failureFromError(err);
      return {
        state: "failed",
        failure: {
          reason,
          fix:
            reason === "rejected"
              ? "The server did not accept the token. Check it, or make a new one."
              : "majhi could not list the server's tools. Check the address and the token.",
        },
        message: `${url.host} did not pass the check.`,
      };
    }
    const all = await this.deps.connectionIds();
    const id = suggestConnectionId(input.name ?? url.host, new Set(all.map((c) => c.id)));
    this.deps.health?.start(id);
    try {
      await this.deps.connections.create(
        {
          org: input.org,
          id,
          type: "mcp",
          name: input.name ?? url.host,
          description: `MCP server at ${url.host}.`,
          fields: { transport: "remote", url: address, protocol: "http", auth: "headers" },
          ...(value === undefined ? {} : { headers: { [header]: { kind: "secret" as const } } }),
        },
        "connections.connectMcpUrl",
        meta,
      );
      if (value !== undefined) {
        await this.deps.connections.setSecret(
          { id, field: header, list: "headers", value },
          "connections.connectMcpUrl",
          meta,
        );
      }
    } catch (err) {
      await this.deps.connections.remove(id, "connections.connectMcpUrl", meta).catch(() => undefined);
      this.deps.health?.remove(id);
      throw err;
    }
    // The same check again, through the stored secret: "connected" is what the next run gets.
    const stored = await this.deps.check(id);
    this.deps.changed();
    if (!stored.ok) {
      return {
        state: "failed",
        failure: stored.failure ?? { reason: "unexpected" },
        message: `${url.host} did not pass the check.`,
      };
    }
    return { state: "connected", connection: id };
  }
}
