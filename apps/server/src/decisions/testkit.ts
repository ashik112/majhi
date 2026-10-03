import { join } from "node:path";
import { type Answer, askedOptions, type DecideRequest, optionKey, type Question } from "@majhi/shared";
import Database from "better-sqlite3";
import { migrate } from "../store/migrations.ts";
import { LabelStore } from "./labels.ts";
import { DecisionLog } from "./log.ts";
import type { DecisionProvider, ProviderOutcome } from "./providers.ts";
import { rulesProvider } from "./rules.ts";
import { DecisionService, type DecisionServiceDeps } from "./service.ts";

/** One question answered `key` at probability `p`, in `runs` order runs that all agree. */
export function sure(q: Question, key: string | boolean | number, p = 0.9, runs = 2): Answer {
  const keys =
    q.type === "choice"
      ? askedOptions(q).map(optionKey)
      : q.type === "noul"
        ? ["true", "false"]
        : [String(key)];
  const rest = keys.length > 1 ? (1 - p) / (keys.length - 1) : 0;
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === String(key) ? p : rest]));
  return {
    value: key,
    confidence: p,
    probabilities,
    ...(q.type === "score" ? {} : { runs: Array.from({ length: runs }, () => probabilities) }),
  };
}

/** What a scripted Laya does with a request: its answers, or a throw, or never an answer. */
export type LayaScript = (request: DecideRequest, call: number) => Promise<Record<string, Answer>>;

/** Plays Laya. By default every question gets its first option at 0.9 in both orders. */
export function fakeLaya(over: { version?: string; script?: LayaScript } = {}) {
  const laya = {
    id: "laya" as const,
    calls: 0,
    version: over.version ?? "0.2.0",
    script: over.script,
    unavailable: async (): Promise<string | undefined> => undefined,
    status: async () => ({ state: "ready" as const }),
    currentVersion: () => laya.version,
    decide: async (request: DecideRequest): Promise<ProviderOutcome> => {
      laya.calls += 1;
      const answers =
        laya.script !== undefined
          ? await laya.script(request, laya.calls)
          : Object.fromEntries(
              Object.entries(request.questions).map(([key, q]) => [
                key,
                sure(
                  q,
                  q.type === "choice"
                    ? (q.options.map(optionKey)[0] ?? "")
                    : q.type === "noul"
                      ? true
                      : q.min,
                ),
              ]),
            );
      return { answers, estimated: false, trimmed: false, version: laya.version };
    },
  };
  return laya;
}

/** A decision service on an in-memory database with a fake Laya, for tests. */
export function service(laya = fakeLaya(), acp?: DecisionProvider) {
  const db = new Database(":memory:");
  migrate(db);
  const deps = {
    // No majhi.yaml: the defaults apply (laya, acp, rules).
    config: { file: join("/nonexistent", "majhi.yaml") },
    log: new DecisionLog(db),
    labels: new LabelStore(db),
    tokens: {},
    laya,
    acp: acp ?? ({ id: "acp", unavailable: async () => "no stand-in", decide: async () => ({}) } as never),
    rules: rulesProvider,
    secrets: {},
    agents: {},
    adminMcpUrl: () => "http://127.0.0.1:1/mcp",
  } as unknown as DecisionServiceDeps;
  return { svc: new DecisionService(deps), db, laya };
}
