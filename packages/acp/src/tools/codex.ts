import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AccountUsage } from "@majhi/shared";
import { z } from "zod";
import { looksExpired, SignInExpired } from "../auth-failure.ts";
import { killTree } from "../exec.ts";
import type { ContextCap, ToolDef, UsageContext } from "./types.ts";

const RateWindow = z
  .looseObject({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullish(),
    resetsAt: z.number().nullish(),
  })
  .nullish();

/** A JSON-RPC message from `codex app-server`. Only the fields majhi reads are required. */
const RpcMessage = z.looseObject({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string() }).optional(),
});

const RateLimitsResult = z.looseObject({
  rateLimits: z.looseObject({
    primary: RateWindow,
    secondary: RateWindow,
    planType: z.string().nullish(),
  }),
});

type ParsedWindow = z.infer<typeof RateWindow>;

/** Windows of a day or less are the short window; longer ones are weekly. */
const SHORT_WINDOW_MAX_MINS = 24 * 60;

function toWindow(w: ParsedWindow) {
  if (w === null || w === undefined) return undefined;
  return {
    usedPct: Math.min(100, Math.max(0, w.usedPercent)),
    ...(w.resetsAt === null || w.resetsAt === undefined
      ? {}
      : { resetsAt: new Date(w.resetsAt * 1000).toISOString() }),
  };
}

/** Maps the `account/rateLimits/read` result. Uses `windowDurationMins` to tell the 5-hour window from the weekly one. */
export function mapCodexRateLimits(result: unknown, now: Date = new Date()): AccountUsage {
  const parsed = RateLimitsResult.safeParse(result);
  if (!parsed.success) throw new Error("Codex reported limits in a shape majhi does not know");
  const { primary, secondary, planType } = parsed.data.rateLimits;
  const usage: AccountUsage = { models: [], estimated: false, updatedAt: now.toISOString() };
  if (planType && planType !== "unknown") usage.plan = planType;
  const slots: [ParsedWindow, "window" | "weekly"][] = [
    [primary, "window"],
    [secondary, "weekly"],
  ];
  for (const [w, fallback] of slots) {
    const mapped = toWindow(w);
    if (mapped === undefined || w === null || w === undefined) continue;
    const mins = w.windowDurationMins;
    const slot =
      mins === null || mins === undefined ? fallback : mins <= SHORT_WINDOW_MAX_MINS ? "window" : "weekly";
    usage[slot] = mapped;
  }
  return usage;
}

/**
 * Talks JSON-RPC to `codex app-server` over stdio: `initialize`, `initialized`,
 * then `account/rateLimits/read`. Kills the process group at the end.
 */
function readCodexUsage(ctx: UsageContext): Promise<AccountUsage> {
  const { adapter, env, timeoutMs } = ctx;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      fn();
    };
    child = spawn(adapter.command, [...adapter.args, "cli", "app-server"], {
      env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(
      () => done(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`))),
      timeoutMs,
    );
    const send = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stdin?.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) =>
      done(() =>
        reject(new Error(err.code === "ENOENT" ? `Command not found: ${adapter.command}` : err.message)),
      ),
    );
    child.on("close", (code) => done(() => reject(new Error(`Codex app-server exited with code ${code}`))));

    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const msg = RpcMessage.safeParse(raw);
      if (!msg.success || msg.data.id === undefined) return;
      const { id, result, error } = msg.data;
      if (id === 1) {
        if (error) return done(() => reject(new Error(error.message)));
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read" });
      } else if (id === 2) {
        if (error)
          return done(() =>
            reject(looksExpired(error.message) ? new SignInExpired(error.message) : new Error(error.message)),
          );
        try {
          const usage = mapCodexRateLimits(result);
          done(() => resolve(usage));
        } catch (err) {
          done(() => reject(err));
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "majhi", title: "majhi", version: "0.0.0" } },
    });
  });
}

/**
 * Codex compacts inside a turn once the conversation reaches `model_auto_compact_token_limit`
 * (codex-cli 0.158.0). codex-acp 2.0.0 merges the JSON in `CODEX_CONFIG` into every session's config.
 */
export function codexCapEnv({ tokens, compactAt }: ContextCap): Record<string, string> {
  return { CODEX_CONFIG: JSON.stringify({ model_auto_compact_token_limit: Math.round(tokens * compactAt) }) };
}

export const codex: ToolDef = {
  capEnv: codexCapEnv,
  info: {
    id: "codex",
    name: "Codex",
    authModes: ["login", "api-key"],
    loginHint: "Open the link, enter the code shown here, then press Enter.",
    apiKeyLabel: "OpenAI API key",
    midTurnCapMin: 0,
  },
  configHomeVar: "CODEX_HOME",
  apiKeyVar: "CODEX_API_KEY",
  // Written by codex for a signed-in account: `models[]` with a `slug` and, for a replaced model,
  // `upgrade: { model }` naming its replacement.
  modelCatalog: "models_cache.json",
  adapter: { command: "codex-acp", args: [] },
  versionArgs: ["cli", "--version"],
  authStatusArgs: ["cli", "login", "status"],
  loginArgs: ["cli", "login", "--device-auth"],
  // codex-acp 2.0.0 reports the last model call of the turn, not a running total.
  turnUsage: "turn",
  // Without this the adapter answers authRequired instead of using the key.
  apiKeyEnv: { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }) },
  readUsage: readCodexUsage,
  parseAuthStatus(exitCode) {
    return { signedIn: exitCode === 0 };
  },
};
