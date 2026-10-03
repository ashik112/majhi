/**
 * The scripted turn and the ACP server of the fake agent. Split from
 * fake-agent.ts so the CLI parts stay small. Erasable TypeScript only.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type SessionConfigOption,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { z } from "zod";

/** A small valid PNG: a bar chart on a dark ground, so screenshots show something. */
export function chartPng(): Buffer {
  const w = 160;
  const h = 90;
  const bars = [30, 52, 41, 68, 60, 78];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const bar = Math.floor((x - 8) / 24);
      const inBar = x >= 8 && (x - 8) % 24 < 18 && bar >= 0 && bar < bars.length;
      const lit = inBar && h - 8 - y < (bars[bar] ?? 0) && y < h - 8;
      const px = lit ? [240, 180, 85] : [23, 24, 28];
      raw.set(px, row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A page that tries to call majhi's API. From a sandboxed page the request must fail. */
export const REPORT_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Latency report</title>
<body style="font-family: sans-serif; padding: 24px">
<h1>Latency report</h1>
<p id="out">Checking access to majhi.</p>
<script>
fetch("/api/cmd/tasks.list", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  .then((r) => { document.getElementById("out").textContent = "reached majhi: " + r.status; })
  .catch(() => { document.getElementById("out").textContent = "blocked from majhi"; });
</script>
</body>
`;

/** A markdown document with a heading, a list and a table, for the file viewer. */
export const NOTES_MD = `# Latency notes

The p99 dropped after the cache change.

## What changed

- Added a read-through cache in \`src/cache.ts\`
- Moved the slow query behind an index
  - \`orders(created_at)\`
- [ ] Load test on staging

## Results

| Metric | Before | After |
|---|---|---|
| p50 | 120 ms | 90 ms |
| p99 | 800 ms | 410 ms |

\`\`\`ts
export const ttl = 60;
\`\`\`
`;

/** A table in the reply itself. */
export const SUMMARY_TABLE = `| Keep | Delete | Safe? |
|---|---|---|
| chart.png | tmp.png | yes |
| report.html | old.html | yes |`;

export interface ServeOptions {
  tool: "claude" | "codex";
  models: string[];
  efforts: string[];
  slowMs: number;
  loadSession: boolean;
  images: boolean;
  signedIn: () => boolean;
  /** Tokens each turn adds to the session's reported usage. 0: the fixed readings 1k, 20k, 42k. */
  risingUsage: number;
  /** `/compact` answers but does not lower usage. */
  compactNoop: boolean;
  /** Token counts every prompt reports in its response, like claude-agent-acp's per-turn tally. Undefined: none. */
  turnTokens:
    | { input: number; output: number; thought: number; cacheRead: number; cacheWrite: number }
    | undefined;
  /** Dollars each prompt adds to the running session cost sent in `usage_update`. Undefined: no cost, like codex-acp. */
  turnCost: number | undefined;
  /** Sent as `_meta["_claude/model"]` with the cost, like claude-agent-acp. */
  usageModel: string | undefined;
}

interface McpEntry {
  name: string;
  url: string;
  headers: Record<string, string>;
}

interface Session {
  cwd: string;
  model: string;
  effort: string;
  cancel: AbortController;
  /** HTTP MCP servers the client gave in newSession or loadSession. */
  mcp: McpEntry[];
  /** The last usage reported, in tokens. */
  used: number;
  /** Running cost of this process's session, in dollars. */
  cost: number;
}

const McpResponse = z.object({
  result: z
    .object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

/**
 * Calls one tool of an MCP server over streamable HTTP, with plain fetch: the JSON-RPC handshake,
 * then tools/call. Answers the text the tool returned and whether it was an error.
 */
async function callMcpTool(
  server: McpEntry,
  name: string,
  args: unknown,
): Promise<{ text: string; isError: boolean }> {
  const post = async (body: object): Promise<unknown> => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: {
        ...server.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${server.name} answered ${res.status}: ${text.slice(0, 200)}`);
    if (text === "") return {};
    // A JSON answer, or one SSE event holding it.
    const json =
      text.startsWith("event:") || text.startsWith("data:")
        ? (text
            .split("\n")
            .find((l) => l.startsWith("data:"))
            ?.slice(5) ?? "{}")
        : text;
    return JSON.parse(json) as unknown;
  };
  await post({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-agent", version: "1" },
    },
  });
  await post({ method: "notifications/initialized" });
  const parsed = McpResponse.parse(
    await post({ id: 2, method: "tools/call", params: { name, arguments: args } }),
  );
  if (parsed.error) return { text: parsed.error.message, isError: true };
  const text = (parsed.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, isError: parsed.result?.isError === true };
}

/**
 * True in the captain's chat: the session has the majhi-admin server and the task folder's TASK.md
 * has the captain chat brief. The captain talking in its chat echoes, so tests never run the coding script.
 */
async function isBossChat(s: Session): Promise<boolean> {
  if (!s.mcp.some((m) => m.name === "majhi-admin")) return false;
  try {
    return /## Brief\n\n(?:Captain chat|Chat)\n/.test(await readFile(join(s.cwd, "TASK.md"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * The steps a prompt asks for, in order: `call: <tool> {json}` calls an MCP tool (on majhi-admin, else
 * the first server; `call: <server>/<tool>` picks one), and `run: <command>` runs a shell command
 * after asking permission, like an agent's own shell.
 */
type Step = { kind: "call"; tool: string; server?: string; args: unknown } | { kind: "run"; command: string };

function promptSteps(text: string): Step[] {
  const steps: Step[] = [];
  for (const line of text.split("\n")) {
    const run = /^run:\s+(.+)$/.exec(line.trim());
    if (run?.[1] !== undefined) {
      steps.push({ kind: "run", command: run[1] });
      continue;
    }
    const m = /^call:\s+(\S+)\s*(.*)$/.exec(line.trim());
    if (m?.[1] === undefined) continue;
    let args: unknown = {};
    try {
      if (m[2]) args = JSON.parse(m[2]) as unknown;
    } catch {
      args = { invalidJson: m[2] };
    }
    const slash = m[1].indexOf("/");
    steps.push(
      slash < 0
        ? { kind: "call", tool: m[1], args }
        : { kind: "call", server: m[1].slice(0, slash), tool: m[1].slice(slash + 1), args },
    );
  }
  return steps;
}

/** Runs a command the way an agent's shell would: in the session's folder, with the agent's environment. */
function runCommand(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, env: process.env, timeout: 20_000 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
        done({ code, output: `${stdout}${stderr}`.trim() });
      },
    );
  });
}

const StoredSession = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "agent"]), text: z.string() })),
});
type StoredSession = z.infer<typeof StoredSession>;

const REPLAY_LAST = 4;

function configOptions(o: ServeOptions, model: string, effort: string): SessionConfigOption[] {
  const toValues = (ids: string[]) => ids.map((id) => ({ value: id, name: id }));
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: toValues(o.models),
    },
    {
      id: o.tool === "claude" ? "effort" : "reasoning_effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: toValues(o.efforts),
    },
  ];
}

function storeFile(cwd: string, id: string): string {
  return join(cwd, ".fake-sessions", `${id}.json`);
}

async function readStored(cwd: string, id: string): Promise<StoredSession | undefined> {
  try {
    return StoredSession.parse(JSON.parse(await readFile(storeFile(cwd, id), "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

async function writeStored(cwd: string, id: string, data: StoredSession): Promise<void> {
  await mkdir(join(cwd, ".fake-sessions"), { recursive: true });
  await writeFile(storeFile(cwd, id), JSON.stringify(data));
}

/** The context window the fake reports. */
const USAGE_SIZE = 200_000;

/** What the fake writes when majhi asks for a handoff note: the fixed template, filled in. */
const FAKE_NOTE = [
  "## Original task",
  "",
  "The task in TASK.md.",
  "",
  "## Done",
  "",
  "Created HEALTH.md.",
  "",
  "## Key decisions",
  "",
  "Keep it small.",
  "",
  "## Remaining work",
  "",
  "Tests.",
  "",
  "## Files touched",
  "",
  "HEALTH.md",
  "",
  "## Next step",
  "",
  "Run the tests.",
].join("\n");

const COMMANDS = [
  { name: "compact", description: "Compact the conversation" },
  { name: "review", description: "Review the current changes" },
];

export function serveAcp(o: ServeOptions): void {
  const sessions = new Map<string, Session>();
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  new AgentSideConnection((conn): Agent => {
    const update = (sessionId: string, u: Parameters<typeof conn.sessionUpdate>[0]["update"]) =>
      conn.sessionUpdate({ sessionId, update: u });

    const register = (cwd: string, sessionId: string, mcpServers: readonly unknown[] = []): Session => {
      const mcp = mcpServers.flatMap((raw): McpEntry[] => {
        const parsed = z
          .object({
            name: z.string(),
            url: z.string(),
            headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
          })
          .safeParse(raw);
        if (!parsed.success) return [];
        const headers = Object.fromEntries(parsed.data.headers.map((h) => [h.name, h.value]));
        return [{ name: parsed.data.name, url: parsed.data.url, headers }];
      });
      const state: Session = {
        cwd,
        model: o.models[0] ?? "",
        effort: o.efforts[0] ?? "",
        cancel: new AbortController(),
        mcp,
        used: 0,
        cost: 0,
      };
      sessions.set(sessionId, state);
      return state;
    };

    async function turn(sessionId: string, s: Session, text: string, images: number): Promise<StopReason> {
      const signal = s.cancel.signal;
      const step = async (): Promise<boolean> => {
        if (o.slowMs > 0) {
          await new Promise<void>((res) => {
            const t = setTimeout(res, o.slowMs);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                res();
              },
              { once: true },
            );
          });
        }
        return signal.aborted;
      };
      const say = (chunk: string) =>
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
      // Fixed readings, or with rising usage a share of this turn's growth on top of the session so far.
      const start = s.used;
      const usage = (fixed: number) => {
        s.used = o.risingUsage > 0 ? start + Math.round((o.risingUsage * fixed) / 42_000) : fixed;
        return update(sessionId, { sessionUpdate: "usage_update", used: s.used, size: USAGE_SIZE });
      };
      const plan = (a: "pending" | "in_progress" | "completed", b: "pending" | "in_progress" | "completed") =>
        update(sessionId, {
          sessionUpdate: "plan",
          entries: [
            { content: "Read the project", priority: "medium", status: a },
            { content: "Write the change", priority: "medium", status: b },
          ],
        });

      // A file name has an extension; the captain's own instructions say "create or split".
      const wanted = /\bcreate\s+(\S+\.\w+)/.exec(text)?.[1] ?? "HEALTH.md";
      const target = resolve(s.cwd, wanted);
      const inside = !relative(s.cwd, target).startsWith("..") && !isAbsolute(relative(s.cwd, target));
      let reply = "";
      const finish = (r: StopReason): StopReason => r;

      await plan("in_progress", "pending");
      await usage(1_000);
      if (await step()) return finish("cancelled");

      for (const chunk of [
        "I will look at ",
        "the project first. ",
        images > 0 ? `Got ${images} image(s). ` : "",
      ]) {
        if (!chunk) continue;
        reply += chunk;
        await say(chunk);
        if (await step()) return finish("cancelled");
      }

      if (/\breport-env\b/.test(text)) {
        const line = `SSH_AUTH_SOCK=${process.env.SSH_AUTH_SOCK ?? "unset"}. `;
        reply += line;
        await say(line);
      }

      await update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "t-read",
        title: "Read package.json",
        kind: "read",
        status: "pending",
        locations: [{ path: join(s.cwd, "package.json") }],
      });
      if (await step()) return finish("cancelled");
      await update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "t-read",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: '{ "name": "fake" }' } }],
      });
      await usage(20_000);
      if (await step()) return finish("cancelled");
      await plan("completed", "in_progress");

      const newText = "# Health\n\nok\n";
      await update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "t-edit",
        title: `Edit ${wanted}`,
        kind: "edit",
        status: "in_progress",
        locations: [{ path: target }],
      });
      if (await step()) return finish("cancelled");
      if (inside) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, newText);
        await update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-edit",
          status: "completed",
          content: [{ type: "diff", path: target, newText }],
        });
        reply += `Created ${wanted}. `;
      } else {
        await update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-edit",
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: "Path is outside the task folder" } }],
        });
      }
      if (await step()) return finish("cancelled");

      await update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "t-exec",
        title: "Run npm test",
        kind: "execute",
        status: "pending",
        rawInput: { command: "npm test" },
      });
      const answer = await conn.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: "t-exec",
          title: "Run npm test",
          kind: "execute",
          rawInput: { command: "npm test" },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "reject";
      if (allowed) {
        await update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-exec",
          status: "in_progress",
        });
        if (await step()) return finish("cancelled");
        await update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-exec",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "2 tests passed" } }],
        });
        reply += "Tests passed. ";
      } else {
        await update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-exec",
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: "Permission denied" } }],
        });
        reply += "I could not run the tests. ";
      }
      if (signal.aborted) return finish("cancelled");

      await plan("completed", "completed");
      await usage(42_000);
      await say(`Done. ${reply.trim()}`);
      return "end_turn";
    }

    return {
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: o.loadSession,
          promptCapabilities: { image: o.images },
          mcpCapabilities: { http: true },
        },
        authMethods: [],
      }),
      authenticate: async () => ({}),
      newSession: async (params) => {
        if (!o.signedIn()) throw RequestError.authRequired(undefined, "Sign in first");
        const sessionId = `fake-${crypto.randomUUID().slice(0, 8)}`;
        const s = register(params.cwd, sessionId, params.mcpServers);
        await writeStored(params.cwd, sessionId, { messages: [] });
        await update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
        return { sessionId, configOptions: configOptions(o, s.model, s.effort) };
      },
      loadSession: async (params) => {
        if (!o.signedIn()) throw RequestError.authRequired(undefined, "Sign in first");
        const stored = await readStored(params.cwd, params.sessionId);
        if (!stored) throw RequestError.resourceNotFound(params.sessionId);
        const s = register(params.cwd, params.sessionId, params.mcpServers);
        for (const m of stored.messages.slice(-REPLAY_LAST)) {
          await update(params.sessionId, {
            sessionUpdate: m.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            content: { type: "text", text: m.text },
          });
        }
        await update(params.sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: COMMANDS,
        });
        return { configOptions: configOptions(o, s.model, s.effort) };
      },
      setSessionConfigOption: async (params) => {
        const state = sessions.get(params.sessionId);
        if (!state) throw RequestError.invalidParams(undefined, "Unknown session");
        if (typeof params.value !== "string")
          throw RequestError.invalidParams(undefined, "Not a boolean option");
        if (params.configId === "model") {
          if (!o.models.includes(params.value)) throw RequestError.invalidParams(undefined, "Unknown model");
          state.model = params.value;
        } else {
          if (!o.efforts.includes(params.value))
            throw RequestError.invalidParams(undefined, "Unknown effort");
          state.effort = params.value;
        }
        const options = configOptions(o, state.model, state.effort);
        await update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: options });
        return { configOptions: options };
      },
      prompt: async (params) => {
        const s = sessions.get(params.sessionId);
        if (!s) throw RequestError.invalidParams(undefined, "Unknown session");
        const text = params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
        const images = params.prompt.filter((b) => b.type === "image").length;
        s.cancel = new AbortController();
        const stored = (await readStored(s.cwd, params.sessionId)) ?? { messages: [] };
        stored.messages.push({ role: "user", text });
        let stopReason: StopReason;
        let agentText: string | undefined;
        if (text.startsWith("crash:")) {
          console.error("fake-agent: crashed on purpose");
          process.exit(3);
        }
        if (text.startsWith("/compact")) {
          // Native compaction: usage drops to a tenth, unless this fake is told it does nothing.
          if (!o.compactNoop) s.used = Math.max(1_000, Math.round(s.used / 10));
          await update(params.sessionId, {
            sessionUpdate: "usage_update",
            used: s.used,
            size: USAGE_SIZE,
          });
          agentText = "Compacted the conversation.";
          await update(params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: agentText },
          });
          stopReason = "end_turn";
        } else if (text.includes("Reply with a handoff note")) {
          agentText = FAKE_NOTE;
          await update(params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: agentText },
          });
          stopReason = "end_turn";
        } else if (text.includes("stop:max_tokens")) {
          // Out of room: the session is full and the turn ends early.
          s.used = USAGE_SIZE;
          await update(params.sessionId, { sessionUpdate: "usage_update", used: s.used, size: USAGE_SIZE });
          agentText = "I ran out of room.";
          await update(params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: agentText },
          });
          stopReason = "max_tokens";
        } else if (text.includes("stop:refusal")) {
          // The model's safeguards stop the turn, as Claude Code reports a flagged message.
          agentText = "API Error: the model's safeguards flagged this message.";
          await update(params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: agentText },
          });
          stopReason = "refusal";
        } else if (text.startsWith("show:")) {
          const say = (content: object) =>
            update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: content as never });
          await mkdir(join(s.cwd, "media"), { recursive: true });
          const png = chartPng();
          await writeFile(join(s.cwd, "media", "chart.png"), png);
          await writeFile(join(s.cwd, "media", "report.html"), REPORT_HTML);
          await writeFile(join(s.cwd, "media", "notes.md"), NOTES_MD);
          agentText = "Here is the chart and the report.";
          await say({
            type: "text",
            text: `${agentText}\n\nThe plan is in [media/notes.md](media/notes.md) and the numbers use the \`latency/p99-ms\` field.\n\n${SUMMARY_TABLE}\n\n![Latency chart](media/chart.png)\n\n[Latency report](media/report.html)\n\nMore at [the docs](https://example.com/docs).`,
          });
          await say({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
          await say({ type: "resource_link", uri: "https://example.com/spec", name: "Spec sheet" });
          stopReason = "end_turn";
        } else if (promptSteps(text).length > 0) {
          const lines: string[] = [];
          let n = 0;
          let cancelled = false;
          const signal = s.cancel.signal;
          // A pause between steps, so a test can stop the turn halfway with Esc.
          const pause = async (): Promise<boolean> => {
            if (o.slowMs > 0) {
              await new Promise<void>((res) => {
                const t = setTimeout(res, o.slowMs);
                signal.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(t);
                    res();
                  },
                  { once: true },
                );
              });
            }
            return signal.aborted;
          };
          for (const step of promptSteps(text)) {
            if (await pause()) {
              cancelled = true;
              break;
            }
            if (step.kind === "run") {
              const toolCallId = `run-${++n}`;
              const call = {
                toolCallId,
                title: step.command,
                kind: "execute" as const,
                rawInput: { command: step.command },
              };
              await update(params.sessionId, { sessionUpdate: "tool_call", ...call, status: "pending" });
              const answer = await conn.requestPermission({
                sessionId: params.sessionId,
                toolCall: call,
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
                  { optionId: "reject", name: "Reject", kind: "reject_once" },
                ],
              });
              const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "reject";
              const result = allowed
                ? await runCommand(step.command, s.cwd)
                : { code: 1, output: "Permission denied" };
              await update(params.sessionId, {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: result.code === 0 ? "completed" : "failed",
                content: [{ type: "content", content: { type: "text", text: result.output } }],
              });
              lines.push(`${step.command}: ${result.output.split("\n", 1)[0] ?? ""}`);
              continue;
            }
            const { tool, args } = step;
            const toolCallId = `mcp-${++n}`;
            await update(params.sessionId, {
              sessionUpdate: "tool_call",
              toolCallId,
              title: tool,
              kind: "other",
              status: "in_progress",
              rawInput: args as never,
            });
            let outcome: { text: string; isError: boolean };
            const server =
              step.server === undefined
                ? (s.mcp.find((m) => m.name === "majhi-admin") ?? s.mcp[0])
                : s.mcp.find((m) => m.name === step.server);
            try {
              if (server === undefined) throw new Error("No MCP server was given to this session");
              outcome = await callMcpTool(server, tool, args);
            } catch (err) {
              outcome = { text: err instanceof Error ? err.message : String(err), isError: true };
            }
            await update(params.sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: outcome.isError ? "failed" : "completed",
              content: [{ type: "content", content: { type: "text", text: outcome.text } }],
            });
            lines.push(`${tool}: ${outcome.text.split("\n", 1)[0] ?? ""}`);
          }
          agentText = cancelled ? undefined : lines.join("\n");
          if (agentText !== undefined) {
            await update(params.sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: agentText },
            });
          }
          stopReason = cancelled ? "cancelled" : "end_turn";
        } else if (text.startsWith("echo:") || (await isBossChat(s))) {
          // A session with the admin server is the captain: it echoes, so tests never run the coding script.
          const admin = s.mcp.some((m) => m.name === "majhi-admin");
          agentText = `echo: ${
            admin
              ? (text
                  .split("\n")
                  .filter((l) => l.trim() !== "")
                  .at(-1) ?? "")
              : text
          }`;
          await update(params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: agentText },
          });
          stopReason = "end_turn";
        } else {
          stopReason = await turn(params.sessionId, s, text, images);
          agentText = stopReason === "end_turn" ? "Done." : undefined;
        }
        if (agentText) stored.messages.push({ role: "agent", text: agentText });
        await writeStored(s.cwd, params.sessionId, stored);
        if (o.turnCost !== undefined) {
          s.cost += o.turnCost;
          await update(params.sessionId, {
            sessionUpdate: "usage_update",
            used: s.used,
            size: USAGE_SIZE,
            cost: { amount: s.cost, currency: "USD" },
            ...(o.usageModel === undefined ? {} : { _meta: { "_claude/model": o.usageModel } }),
          });
        }
        const t = o.turnTokens;
        if (t === undefined) return { stopReason };
        return {
          stopReason,
          usage: {
            totalTokens: t.input + t.output + t.thought + t.cacheRead + t.cacheWrite,
            inputTokens: t.input,
            outputTokens: t.output,
            thoughtTokens: t.thought,
            cachedReadTokens: t.cacheRead,
            cachedWriteTokens: t.cacheWrite,
          },
        };
      },
      cancel: async (params) => {
        sessions.get(params.sessionId)?.cancel.abort();
      },
    };
  }, stream);
}
