import { Readable, Writable } from "node:stream";
import {
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type McpServer,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { AcpAuthRequired, extractOptions, isAuthRequired, type SessionOptions } from "./acp-session.ts";
import { buildEnv } from "./env.ts";
import { prepareHome } from "./home.ts";
import { type DebugLog, MessageRuns, normalizeUpdate } from "./normalize.ts";
import { buildAsk } from "./permission.ts";
import type {
  AgentSession,
  McpServerSpec,
  PermissionAsk,
  PromptBlock,
  SessionEvent,
  SessionStart,
  StdioServerSpec,
} from "./session.ts";
import { localSpawner } from "./spawn.ts";
import { getTool } from "./tools/index.ts";
import { TurnMeter } from "./turn-usage.ts";

const DEFAULT_HANDSHAKE_MS = 30_000;
const DEFAULT_CANCEL_MS = 10_000;
const MAX_BUFFERED = 200;

type PermissionHandler = (ask: PermissionAsk, signal: AbortSignal) => Promise<string | undefined>;
type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

function toMcp(s: McpServerSpec | StdioServerSpec): McpServer {
  if (s.type === "stdio") {
    return {
      name: s.name,
      command: s.command,
      args: s.args,
      env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
    };
  }
  return {
    type: "http",
    name: s.name,
    url: s.url,
    headers: Object.entries(s.headers).map(([name, value]) => ({ name, value })),
  };
}

function toBlock(b: PromptBlock, imageOk: boolean): ContentBlock {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      if (imageOk) return { type: "image", data: b.data, mimeType: b.mime };
      return {
        type: "text",
        text: `[An image (${b.mime}) was attached, but this agent cannot read images.]`,
      };
    case "resource_link":
      return b.mime
        ? { type: "resource_link", uri: b.uri, name: b.name, mimeType: b.mime }
        : { type: "resource_link", uri: b.uri, name: b.name };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Starts the adapter and opens (or resumes) one ACP session. Events emitted
 * before the first `onEvent` listener attaches are buffered and delivered to
 * it, so the commands list sent right after `session/new` is not lost.
 * Updates replayed by `session/load` are dropped, except the latest commands
 * and usage, which are kept as current state.
 */
export async function openSession(start: SessionStart, log: DebugLog = () => {}): Promise<AgentSession> {
  const { account, options } = start;
  await prepareHome(account);
  const env = buildEnv(account, options.base, start.git);
  const adapter = options.adapters?.[account.tool] ?? getTool(account.tool).adapter;

  const spawned = await (options.spawner ?? localSpawner)({
    command: adapter,
    env,
    cwd: start.cwd,
    account,
    ...(start.mounts === undefined ? {} : { mounts: start.mounts }),
    ...(start.scratch === true ? { scratch: true } : {}),
    ...(start.task === undefined ? {} : { task: start.task }),
  });
  const { child, cwd } = spawned;
  let stderrTail = "";
  child.stderr.on("data", (d: Buffer) => {
    const line = d.toString().trim().split("\n").pop();
    if (line) stderrTail = line;
  });

  let closing = false;
  let exited = false;
  const exitDone = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const listeners = new Set<(e: SessionEvent) => void>();
  let buffered: SessionEvent[] | undefined = [];
  const emit = (e: SessionEvent) => {
    if (listeners.size === 0 && buffered) {
      if (buffered.length < MAX_BUFFERED) buffered.push(e);
      return;
    }
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (err) {
        log("listener threw", err);
      }
    }
  };

  const dead = new Promise<never>((_, reject) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      exited = true;
      reject(new Error(err.code === "ENOENT" ? `Command not found: ${adapter.command}` : err.message));
    });
    child.once("close", (code, signal) => {
      exited = true;
      const detail = stderrTail ? `: ${stderrTail}` : "";
      const message = `Agent exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail}`;
      if (!closing) {
        emit(stderrTail ? { type: "exit", code, error: stderrTail } : { type: "exit", code });
      }
      reject(new Error(closing ? "Session is closed" : message));
    });
  });
  dead.catch(() => {});
  // A dying process closes the connection a moment before its exit is reported.
  // Prefer the exit message, which names the cause, over "connection closed".
  const alive = <T>(p: Promise<T>): Promise<T> => {
    const guarded = p.catch(async (err: unknown) => {
      await Promise.race([dead, new Promise((r) => setTimeout(r, 1000))]);
      throw err;
    });
    guarded.catch(() => {});
    return Promise.race([guarded, dead]);
  };

  // Mutable session state.
  let sessionId = "";
  let configOptions: SessionConfigOption[] = [];
  let imageOk = false;
  let loading = false;
  const loadState = new Map<string, SessionEvent>();
  let handler: PermissionHandler | undefined;
  let turn: { abort: AbortController; settled: Promise<void> } | undefined;
  const runs = new MessageRuns(crypto.randomUUID().slice(0, 8));
  const meter = new TurnMeter(getTool(account.tool).turnUsage);

  const currentValues = (): { model?: string; effort?: string } => {
    const o = extractOptions(configOptions);
    const v: { model?: string; effort?: string } = {};
    if (o.defaultModel) v.model = o.defaultModel;
    if (o.defaultEffort) v.effort = o.defaultEffort;
    return v;
  };

  const client: Client = {
    requestPermission: async (req) => {
      const ask = buildAsk(req);
      const cancelled = { outcome: { outcome: "cancelled" as const } };
      if (!handler || !turn) return cancelled;
      const signal = turn.abort.signal;
      if (signal.aborted) return cancelled;
      const aborted = new Promise<undefined>((resolve) =>
        signal.addEventListener("abort", () => resolve(undefined), { once: true }),
      );
      let id: string | undefined;
      try {
        id = await Promise.race([handler(ask, signal), aborted]);
      } catch (err) {
        log("permission handler threw", err);
      }
      if (id === undefined || !ask.options.some((o) => o.id === id)) return cancelled;
      return { outcome: { outcome: "selected" as const, optionId: id } };
    },
    sessionUpdate: ({ update }) => {
      if (update.sessionUpdate === "config_option_update") {
        configOptions = update.configOptions;
        if (!loading) emit({ type: "config", ...currentValues() });
        return;
      }
      for (const e of normalizeUpdate(update, runs, log)) {
        // A replayed cost belongs to the old process, so only live reports count toward a turn.
        if (e.type === "usage" && !loading) meter.note(e);
        if (!loading) emit(e);
        else if (e.type === "commands" || e.type === "usage") loadState.set(e.type, e);
      }
    },
  };

  let conn: ClientSideConnection;
  const fail = async (err: unknown): Promise<never> => {
    closing = true;
    spawned.kill();
    await exitDone;
    if (isAuthRequired(err)) throw new AcpAuthRequired("Sign-in required");
    throw err instanceof Error ? err : new Error(String(err));
  };

  try {
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    conn = new ClientSideConnection(() => client, stream);
    const mcpServers = (start.mcpServers ?? []).map(toMcp);

    const handshake = (async () => {
      const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const caps = init.agentCapabilities;
      imageOk = caps?.promptCapabilities?.image === true;

      let resumed = false;
      if (start.resume && caps?.loadSession) {
        loading = true;
        try {
          const loaded = await conn.loadSession({ sessionId: start.resume, cwd, mcpServers });
          sessionId = start.resume;
          configOptions = loaded.configOptions ?? configOptions;
          resumed = true;
        } catch (err) {
          if (isAuthRequired(err) || exited) throw err;
          log("session/load failed", err);
          emit({
            type: "notice",
            level: "warn",
            text: "Could not resume the previous session. Started a new one.",
          });
        } finally {
          loading = false;
        }
        for (const e of loadState.values()) emit(e);
      } else if (start.resume) {
        emit({
          type: "notice",
          level: "info",
          text: "This agent cannot resume sessions. Started a new one.",
        });
      }
      if (!resumed) {
        const created = await conn.newSession({ cwd, mcpServers });
        sessionId = created.sessionId;
        configOptions = created.configOptions ?? [];
      }
    })();
    await withTimeout(
      alive(handshake),
      options.timeoutMs ?? DEFAULT_HANDSHAKE_MS,
      "Timed out starting the agent session",
    );
  } catch (err) {
    return fail(err);
  }

  const optionFor = (category: "model" | "thought_level") =>
    configOptions.find((o) => o.category === category);

  const setOption = async (category: "model" | "thought_level", value: string): Promise<void> => {
    const opt = optionFor(category);
    const label = category === "model" ? "model" : "effort";
    if (!opt) throw new Error(`This agent does not offer a ${label} setting`);
    const offered = extractOptions([opt]);
    const values = category === "model" ? offered.models : offered.efforts;
    if (!values.some((v) => v.id === value)) throw new Error(`Unknown ${label}: ${value}`);
    const res = await alive(conn.setSessionConfigOption({ sessionId, configId: opt.id, value }));
    configOptions = res.configOptions;
    emit({ type: "config", ...currentValues() });
  };

  for (const [category, wanted] of [
    ["model", start.model],
    ["thought_level", start.effort],
  ] as const) {
    if (!wanted) continue;
    const label = category === "model" ? "model" : "effort";
    try {
      await setOption(category, wanted);
    } catch (err) {
      if (exited) return fail(err);
      const kept = category === "model" ? currentValues().model : currentValues().effort;
      emit({
        type: "notice",
        level: "warn",
        text: `${err instanceof Error ? err.message : String(err)}. Keeping the default${kept ? ` ${label} (${kept})` : ""}.`,
      });
    }
  }

  const session: AgentSession = {
    get sessionId() {
      return sessionId;
    },
    pid: child.pid,
    get models(): SessionOptions {
      return extractOptions(configOptions);
    },
    onEvent(listener) {
      listeners.add(listener);
      if (buffered) {
        const pending = buffered;
        buffered = undefined;
        for (const e of pending) listener(e);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    setPermissionHandler(h) {
      handler = h;
    },
    async prompt(blocks) {
      if (closing || exited) throw new Error("Session is closed");
      if (turn) throw new Error("A prompt is already running in this session");
      runs.reset();
      meter.begin();
      const abort = new AbortController();
      const running = alive(conn.prompt({ sessionId, prompt: blocks.map((b) => toBlock(b, imageOk)) }));
      turn = {
        abort,
        settled: running.then(
          () => {},
          () => {},
        ),
      };
      try {
        const res = await running;
        emit({ type: "turn", usage: meter.end(res.usage, currentValues().model) });
        return { stopReason: res.stopReason as StopReason };
      } finally {
        abort.abort();
        turn = undefined;
      }
    },
    async cancel() {
      const t = turn;
      if (!t) return;
      t.abort.abort();
      try {
        await alive(conn.cancel({ sessionId }));
      } catch (err) {
        if (exited) return;
        throw err;
      }
      await withTimeout(
        t.settled,
        start.cancelTimeoutMs ?? DEFAULT_CANCEL_MS,
        "The agent did not stop after cancel",
      );
    },
    setOption,
    async close() {
      closing = true;
      turn?.abort.abort();
      spawned.kill();
      await exitDone;
      listeners.clear();
    },
  };
  return session;
}
