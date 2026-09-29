/**
 * The scripted turn and the ACP server of the fake agent. Split from
 * fake-agent.ts so the CLI parts stay small. Erasable TypeScript only.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
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

export interface ServeOptions {
  tool: "claude" | "codex";
  models: string[];
  efforts: string[];
  slowMs: number;
  loadSession: boolean;
  images: boolean;
  signedIn: () => boolean;
}

interface Session {
  cwd: string;
  model: string;
  effort: string;
  cancel: AbortController;
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

    const register = (cwd: string, sessionId: string): Session => {
      const state: Session = {
        cwd,
        model: o.models[0] ?? "",
        effort: o.efforts[0] ?? "",
        cancel: new AbortController(),
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
      const usage = (used: number) =>
        update(sessionId, { sessionUpdate: "usage_update", used, size: 200_000 });
      const plan = (a: "pending" | "in_progress" | "completed", b: "pending" | "in_progress" | "completed") =>
        update(sessionId, {
          sessionUpdate: "plan",
          entries: [
            { content: "Read the project", priority: "medium", status: a },
            { content: "Write the change", priority: "medium", status: b },
          ],
        });

      const wanted = /\bcreate\s+(\S+)/.exec(text)?.[1] ?? "HEALTH.md";
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
        agentCapabilities: { loadSession: o.loadSession, promptCapabilities: { image: o.images } },
        authMethods: [],
      }),
      authenticate: async () => ({}),
      newSession: async (params) => {
        if (!o.signedIn()) throw RequestError.authRequired(undefined, "Sign in first");
        const sessionId = `fake-${crypto.randomUUID().slice(0, 8)}`;
        const s = register(params.cwd, sessionId);
        await writeStored(params.cwd, sessionId, { messages: [] });
        await update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
        return { sessionId, configOptions: configOptions(o, s.model, s.effort) };
      },
      loadSession: async (params) => {
        if (!o.signedIn()) throw RequestError.authRequired(undefined, "Sign in first");
        const stored = await readStored(params.cwd, params.sessionId);
        if (!stored) throw RequestError.resourceNotFound(params.sessionId);
        const s = register(params.cwd, params.sessionId);
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
        if (text.startsWith("echo:")) {
          agentText = `echo: ${text}`;
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
        return { stopReason };
      },
      cancel: async (params) => {
        sessions.get(params.sessionId)?.cancel.abort();
      },
    };
  }, stream);
}
