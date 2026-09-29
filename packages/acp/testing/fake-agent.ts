/**
 * Fake ACP adapter for tests. Run with `node fake-agent.ts --tool claude [flags] [tool argv]`.
 * Flags come first, then the tool's own argv (`--cli auth status --json`, `cli login status`).
 * No tool argv means: speak ACP over stdio. Never touches the network or real credentials.
 * Only erasable TypeScript here, so Node runs it without a build step.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { z } from "zod";

const Flags = z.object({
  tool: z.enum(["claude", "codex"]),
  signedIn: z.boolean(),
  broken: z.boolean(),
  models: z.array(z.string().min(1)),
  efforts: z.array(z.string().min(1)),
});
type Flags = z.infer<typeof Flags>;

function parseFlags(argv: string[]): { flags: Flags; rest: string[] } {
  const raw: {
    tool?: string | undefined;
    signedIn: boolean;
    broken: boolean;
    models: string[];
    efforts: string[];
  } = {
    signedIn: false,
    broken: false,
    models: ["fake-model-a", "fake-model-b"],
    efforts: ["low", "medium", "high"],
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tool") raw.tool = argv[++i];
    else if (a === "--signed-in") raw.signedIn = true;
    else if (a === "--broken") raw.broken = true;
    else if (a === "--models") raw.models = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--efforts") raw.efforts = (argv[++i] ?? "").split(",").filter(Boolean);
    else break;
  }
  return { flags: Flags.parse(raw), rest: argv.slice(i) };
}

const CLAUDE_VERSION = "2.1.284 (Claude Code)";
const CODEX_VERSION = "codex-cli 0.158.0";

function homeFor(flags: Flags): string {
  const v = flags.tool === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  if (!v) throw new Error("config home is not set");
  return v;
}

function credentialFile(flags: Flags): string {
  return join(homeFor(flags), flags.tool === "claude" ? ".credentials.json" : "auth.json");
}

function isSignedIn(flags: Flags): boolean {
  if (flags.signedIn) return true;
  const key = flags.tool === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.CODEX_API_KEY;
  if (key) return true;
  return existsSync(credentialFile(flags));
}

function readLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    rl.once("line", (line) => {
      resolve(line);
      rl.close();
    });
    rl.once("close", () => resolve(""));
  });
}

async function writeCredentials(flags: Flags): Promise<void> {
  await mkdir(homeFor(flags), { recursive: true, mode: 0o700 });
  const body =
    flags.tool === "claude"
      ? { claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: 0 } }
      : { tokens: { access_token: "fake-access", refresh_token: "fake-refresh" } };
  await writeFile(credentialFile(flags), JSON.stringify(body), { mode: 0o600 });
}

async function runCli(flags: Flags, argv: string[]): Promise<number> {
  const line = argv.join(" ");
  if (flags.tool === "claude") {
    if (line === "--cli --version") {
      console.log(CLAUDE_VERSION);
      return 0;
    }
    if (line === "--cli auth status --json") {
      const signedIn = isSignedIn(flags);
      console.log(
        JSON.stringify(
          signedIn
            ? { loggedIn: true, email: "fake@example.com", orgName: "Fake Org", subscriptionType: "max" }
            : { loggedIn: false },
        ),
      );
      return signedIn ? 0 : 1;
    }
    if (line === "--cli auth login --claudeai") {
      console.log("Opening browser to sign in: https://claude.ai/oauth/authorize?fake=1");
      process.stdout.write("Paste code here if prompted > ");
      const code = (await readLine()).trim();
      if (!code) {
        console.error("\nLogin failed: no code");
        return 1;
      }
      await writeCredentials(flags);
      console.log("\nLogin successful.");
      return 0;
    }
  } else {
    if (line === "cli --version") {
      console.log(CODEX_VERSION);
      return 0;
    }
    if (line === "cli login status") {
      const signedIn = isSignedIn(flags);
      console.log(signedIn ? "Logged in using ChatGPT" : "Not logged in");
      return signedIn ? 0 : 1;
    }
    if (line === "cli login --device-auth") {
      console.log("Open https://auth.openai.com/codex/device and enter the code FAKE-1234");
      console.log("Press Enter once you have finished in the browser");
      await readLine();
      await writeCredentials(flags);
      console.log("Successfully logged in");
      return 0;
    }
  }
  console.error(`fake-agent: unknown command: ${line}`);
  return 2;
}

function configOptions(flags: Flags, model: string, effort: string): SessionConfigOption[] {
  const toValues = (ids: string[]) => ids.map((id) => ({ value: id, name: id }));
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: toValues(flags.models),
    },
    {
      id: flags.tool === "claude" ? "effort" : "reasoning_effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: toValues(flags.efforts),
    },
  ];
}

function serveAcp(flags: Flags): void {
  const sessions = new Map<string, { model: string; effort: string }>();
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  new AgentSideConnection((conn): Agent => {
    return {
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      }),
      authenticate: async () => ({}),
      newSession: async () => {
        if (!isSignedIn(flags)) throw RequestError.authRequired(undefined, "Sign in first");
        const sessionId = `fake-${sessions.size + 1}`;
        const state = { model: flags.models[0] ?? "", effort: flags.efforts[0] ?? "" };
        sessions.set(sessionId, state);
        return { sessionId, configOptions: configOptions(flags, state.model, state.effort) };
      },
      setSessionConfigOption: async (params) => {
        const state = sessions.get(params.sessionId);
        if (!state) throw RequestError.invalidParams(undefined, "Unknown session");
        if (typeof params.value !== "string")
          throw RequestError.invalidParams(undefined, "Not a boolean option");
        if (params.configId === "model") state.model = params.value;
        else state.effort = params.value;
        return { configOptions: configOptions(flags, state.model, state.effort) };
      },
      prompt: async (params) => {
        const text = params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } },
        });
        return { stopReason: "end_turn" };
      },
      cancel: async () => {},
    };
  }, stream);
}

async function main(): Promise<void> {
  const { flags, rest } = parseFlags(process.argv.slice(2));
  if (flags.broken) {
    console.error("fake-agent: broken on purpose");
    process.exit(1);
  }
  if (rest.length > 0) {
    process.exit(await runCli(flags, rest));
  }
  serveAcp(flags);
}

await main();
