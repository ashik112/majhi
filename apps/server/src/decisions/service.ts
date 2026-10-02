import { randomUUID } from "node:crypto";
import type { McpServerSpec } from "@majhi/acp";
import {
  type Answer,
  type CommandMeta,
  type DecideRequest,
  type DecideRequestInput,
  DecideRequestSchema,
  type DecisionOutcome,
  type DecisionPatchSchema,
  type DecisionRecord,
  type DecisionResult,
  type DecisionSettings,
  type Gate,
  gateAnswer,
  type LayaStatus,
  type ProviderId,
  type Question,
} from "@majhi/shared";
import type { z } from "zod";
import { secretName } from "../accounts/homes.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";
import { difficultyQuestion, isDifficulty } from "../runs/difficulty.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Decisions, RateTaskRequest, TaskRating } from "./api.ts";
import { runChain } from "./chain.ts";
import { JevProvider } from "./jev.ts";
import type { LayaProvider } from "./layaProvider.ts";
import type { DecisionLog } from "./log.ts";
import type { DecisionProvider } from "./providers.ts";
import { readDecisionSettings } from "./settings.ts";
import type { DecideTokens } from "./tokens.ts";

export const DECIDE_SERVER_NAME = "majhi-decide";
export const DECIDE_PATH = "/mcp/decide";

const NAMES: Record<ProviderId, string> = {
  laya: "Laya",
  jev: "Jev",
  acp: "The stand-in agent",
  rules: "Rules",
};

export interface DecisionServiceDeps {
  config: ConfigService;
  log: DecisionLog;
  tokens: DecideTokens;
  laya: LayaProvider;
  acp: DecisionProvider;
  rules: DecisionProvider;
  secrets: SecretStore;
  agents: AgentStore;
  /** The majhi-admin MCP URL. The decide URL sits next to it, and main.ts sets the port after listening. */
  adminMcpUrl: () => string;
  now?: () => Date;
}

interface Use {
  use: DecisionRecord["use"];
  task?: string;
  agent?: string;
}

/** The decision provider (SPEC 5.12): the chain, the log, model picking and the `majhi-decide` tool. */
export class DecisionService implements Decisions {
  private readonly now: () => Date;
  private readonly jev: JevProvider;

  constructor(private readonly deps: DecisionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.jev = new JevProvider(async () => {
      const ref = (await this.settings()).jev_key;
      return ref === undefined ? undefined : deps.secrets.get(secretName(ref));
    });
  }

  settings(): Promise<DecisionSettings> {
    return readDecisionSettings(this.deps.config.file);
  }

  private providers(): Record<ProviderId, DecisionProvider> {
    return { laya: this.deps.laya, jev: this.jev, acp: this.deps.acp, rules: this.deps.rules };
  }

  /** Runs the chain and records the decision. */
  async decide(input: DecideRequestInput, use: Use): Promise<DecisionResult> {
    const request = DecideRequestSchema.parse(input);
    const started = performance.now();
    const settings = await this.settings();
    const chain = await runChain(settings.order, this.providers(), request);
    const answers = Object.fromEntries(
      Object.entries(chain.answers).map(([key, a]) => {
        const q = request.questions[key];
        return [key, q === undefined ? a : { ...a, gate: gate(q, a, chain.provider, settings) }];
      }),
    );
    const { sent, version, ...rest } = chain;
    const result: DecisionResult = {
      id: `dec_${randomUUID().slice(0, 8)}`,
      ...rest,
      answers,
      durationMs: Math.round(performance.now() - started),
    };
    this.deps.log.add({
      id: result.id,
      at: this.now().toISOString(),
      use: use.use,
      ...(use.task === undefined ? {} : { task: use.task }),
      ...(use.agent === undefined ? {} : { agent: use.agent }),
      summary: summarize(request),
      provider: result.provider,
      answers: result.answers,
      estimated: result.estimated,
      durationMs: result.durationMs,
      request: {
        state: sent?.state ?? request.state,
        questions: request.questions,
        ...(sent === undefined ? {} : { sent: sent.questions }),
      },
      trimmed: result.trimmed,
      skipped: result.skipped,
      ...(version === undefined ? {} : { version }),
    });
    return result;
  }

  outcome(id: string, outcome: DecisionOutcome): void {
    this.deps.log.setOutcome(id, outcome);
  }

  /** The owner's "Wrong pick". Kept for learning; changes nothing else. */
  correct(input: { id: string; right: string; note?: string | undefined }): DecisionRecord {
    const correction = {
      right: input.right,
      ...(input.note === undefined || input.note === "" ? {} : { note: input.note }),
      at: this.now().toISOString(),
    };
    if (!this.deps.log.correct(input.id, correction))
      throw new UserError(`There is no decision ${input.id}.`, 404);
    const record = this.deps.log.get(input.id);
    if (record === undefined) throw new Error(`Decision ${input.id} cannot be read.`);
    return record;
  }

  ask(request: DecideRequest): Promise<DecisionResult> {
    return this.decide(request, { use: "owner" });
  }

  recent(limit: number, offset = 0): DecisionRecord[] {
    return this.deps.log.recent(limit, offset);
  }

  async status() {
    const settings = await this.settings();
    const laya = await this.deps.laya.status();
    const all = this.providers();
    const ids = [...new Set<ProviderId>([...settings.order, "laya", "jev", "acp", "rules"])];
    const providers = await Promise.all(
      ids.map(async (id) => {
        const reason = id === "laya" ? layaReason(laya) : await all[id].unavailable();
        return { id, available: reason === undefined, detail: reason ?? "Ready" };
      }),
    );
    return { settings, laya, providers };
  }

  async set(
    patch: z.infer<typeof DecisionPatchSchema>,
    meta: CommandMeta,
    command = "decisions.set",
  ): Promise<DecisionSettings> {
    if ((await this.deps.config.sections()).exists !== true) {
      throw new UserError("Pick workspace roots first.", 409);
    }
    if (patch.order !== undefined && new Set(patch.order).size !== patch.order.length) {
      throw new UserError("A provider can appear in the order only once.");
    }
    if (patch.acp_agent !== undefined) {
      const stored = await this.deps.agents.get(patch.acp_agent);
      if (stored === undefined) throw new UserError(`There is no agent @${patch.acp_agent}.`, 404);
    }
    if (patch.jev_key !== undefined && !(await this.deps.secrets.has(secretName(patch.jev_key)))) {
      throw new UserError(`There is no secret ${patch.jev_key}. Save the key first.`, 404);
    }
    await this.deps.config.setSettings(
      { decisions: patch },
      { command, meta, summary: `changed decisions: ${Object.keys(patch).join(", ") || "nothing"}` },
    );
    return this.settings();
  }

  install(): Promise<LayaStatus> {
    return this.deps.laya.install();
  }

  async rateTask(request: RateTaskRequest): Promise<TaskRating | undefined> {
    try {
      const result = await this.decide(difficultyQuestion(request), {
        use: request.use ?? "model-pick",
        ...(request.task === undefined ? {} : { task: request.task }),
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      });
      const a = result.answers.difficulty;
      if (a === undefined) return undefined;
      const level = isDifficulty(a.value) ? a.value : undefined;
      return {
        ...(level === undefined ? {} : { level }),
        confidence: a.confidence,
        counted: level !== undefined && a.gate?.accepted === true,
        why: a.gate?.reason ?? "",
        decisionId: result.id,
        provider: result.provider,
        by: NAMES[result.provider],
      };
    } catch {
      return undefined;
    }
  }

  attachTool(task: string, agent: string): { token: string; server: McpServerSpec } | undefined {
    const token = this.deps.tokens.issue({ task, agent });
    return {
      token,
      server: {
        type: "http",
        name: DECIDE_SERVER_NAME,
        url: this.deps.adminMcpUrl().replace(/\/mcp$/, DECIDE_PATH),
        headers: { Authorization: `Bearer ${token}` },
      },
    };
  }

  revoke(token: string): void {
    this.deps.tokens.revoke(token);
  }
}

/** Whether an answer counts. The rules provider only guesses, so its answers never do. */
function gate(q: Question, a: Answer, provider: ProviderId, settings: DecisionSettings): Gate {
  const g = gateAnswer(q, a, settings);
  return provider === "rules" ? { ...g, accepted: false, reason: "the rules only guess" } : g;
}

function layaReason(laya: LayaStatus): string | undefined {
  if (laya.state === "ready" || laya.state === "loaded") return undefined;
  return laya.detail ?? `Laya is ${laya.state.replace("-", " ")}`;
}

/** One line per question for the log. */
function summarize(request: DecideRequest): string {
  return Object.entries(request.questions)
    .map(([key, q]) => `${key}: ${q.instructions}`.slice(0, 200))
    .join("\n");
}
