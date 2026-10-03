import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../store/migrations.ts";
import { DecisionLog } from "./log.ts";
import type { DecisionProvider } from "./providers.ts";
import { rulesProvider } from "./rules.ts";
import { DecisionService, type DecisionServiceDeps } from "./service.ts";

/** Plays Laya: counts calls and answers `small` at 0.9. */
function fakeLaya(over: { version?: string } = {}) {
  const laya = {
    id: "laya" as const,
    calls: 0,
    version: over.version ?? "0.2.0",
    unavailable: async (): Promise<string | undefined> => undefined,
    status: async () => ({ state: "ready" as const }),
    currentVersion: () => laya.version,
    decide: async () => {
      laya.calls += 1;
      return {
        answers: {
          size: {
            value: "small",
            confidence: 0.9,
            probabilities: { small: 0.9, large: 0.05, none: 0.05 },
            runs: [
              { small: 0.9, large: 0.05, none: 0.05 },
              { small: 0.9, large: 0.05, none: 0.05 },
            ],
          },
        },
        estimated: false,
        trimmed: false,
      };
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
