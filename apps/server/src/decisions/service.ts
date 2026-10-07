import { randomUUID } from "node:crypto";
import type { McpServerSpec } from "@majhi/acp";
import {
  type Answer,
  answerChoices,
  type Calibration,
  type CommandMeta,
  type DecideRequest,
  type DecideRequestInput,
  DecideRequestSchema,
  type DecisionLabel,
  type DecisionOutcome,
  type DecisionPatchSchema,
  type DecisionRecord,
  type DecisionResult,
  type DecisionSettings,
  DecisionSettingsSchema,
  type EvalReport,
  type Gate,
  gateAnswer,
  type LayaStatus,
  type LinkKind,
  type ProviderId,
  type Question,
  type SlotStatus,
} from "@majhi/shared";
import type { z } from "zod";
import { secretName } from "../accounts/homes.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";
import { difficultyQuestion, isDifficulty } from "../runs/difficulty.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { DecideUse, Decisions, RateTaskRequest, TaskRating } from "./api.ts";
import { type CachedDecision, cacheKey, DecisionCache } from "./cache.ts";
import { baseGate, fitSlot, liveGate, previewGate } from "./calibration.ts";
import type { CalibrationStore } from "./calibrationStore.ts";
import { CircuitBreaker, runChain } from "./chain.ts";
import { bestLabels, type EvalProvider, EvalRunner } from "./evalRunner.ts";
import type { EvalStore } from "./evalStore.ts";
import { JevProvider } from "./jev.ts";
import { type LabelStore, sizeBucket, type TaskOutcome } from "./labels.ts";
import type { LayaProvider } from "./layaProvider.ts";
import type { DecisionLog } from "./log.ts";
import type { DecisionProvider } from "./providers.ts";
import { readDecisionSettings } from "./settings.ts";
import {
  MIN_LABELS,
  READ_BY_HAND,
  REFIT_EVERY,
  type SlotDef,
  type SlotRegistry,
  TEACHER_PER_DAY,
} from "./slots.ts";
import type { DecideTokens } from "./tokens.ts";
import { regressionOf } from "./uses/weekly-eval.ts";

export const DECIDE_SERVER_NAME = "majhi-decide";
export const DECIDE_PATH = "/mcp/decide";

const NAMES: Record<ProviderId, string> = {
  laya: "Laya",
  jev: "Jev",
  acp: "The stand-in agent",
  rules: "Rules",
};

export interface DecisionServiceDeps {
  /** Decision ids. Tests count up: the calibration splits labels by id, so random ids split them differently each run. */
  newId?: () => string;
  config: ConfigService;
  log: DecisionLog;
  labels: LabelStore;
  /** The decision slots: what is labeled, evaluated and gated. */
  slots: SlotRegistry;
  evals: EvalStore;
  calibrations: CalibrationStore;
  /** Overrides how long each provider gets, for tests. */
  budgets?: Partial<Record<ProviderId, number>>;
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

type Use = DecideUse;

/** The decision provider (SPEC 5.12): the chain, the log, model picking and the `majhi-decide` tool. */
export class DecisionService implements Decisions {
  private readonly now: () => Date;
  private readonly jev: JevProvider;
  /** Skips a provider that keeps failing, for a while, so a down Laya costs one slow call and not many. */
  readonly breaker = new CircuitBreaker();
  /** Laya answers the same request the same way, so a repeat is answered from here. */
  readonly cache = new DecisionCache();
  /** Requests being answered now, so an identical one shares the answer. */
  private readonly inflight = new Map<string, Promise<CachedDecision | undefined>>();
  private readonly runner: EvalRunner;
  /** The bar the eval scores with: refreshed when an eval starts. */
  private barSettings: DecisionSettings | undefined;
  /** The label count of each slot when a fit was last tried, so a fit that finds nothing is not retried on every label. */
  private readonly triedAt = new Map<string, number>();

  constructor(private readonly deps: DecisionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    const laya = deps.laya;
    const provider: EvalProvider = {
      id: "laya",
      version: () => laya.currentVersion(),
      costPer1000Usd: 0,
      ask: async (request) => (await laya.decide(request)).answers,
    };
    this.runner = new EvalRunner({
      registry: deps.slots,
      labels: deps.labels,
      log: deps.log,
      results: deps.evals,
      provider,
      calibrations: deps.calibrations,
      gate: (_slot, q, a, cal) =>
        previewGate(q, a, cal, this.barSettings ?? DecisionSettingsSchema.parse({})),
      fit: (slot, items, version) =>
        fitSlot(slot, items, version, {
          now: this.now,
          settings: this.barSettings ?? DecisionSettingsSchema.parse({}),
        }),
      now: this.now,
    });
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
    // The rules always close the chain: their answer never counts, so the caller applies its own safe default at once.
    const wanted = use.order ?? settings.order;
    const order = wanted.includes("rules") ? [...wanted] : [...wanted, "rules" as const];
    const first = order[0];
    if (use.perDay !== undefined && first !== undefined && first !== "rules") {
      const dayStart = new Date(this.now());
      dayStart.setUTCHours(0, 0, 0, 0);
      if (this.deps.log.countSince(use.use, first, dayStart.toISOString()) >= use.perDay)
        throw new UserError(
          `The daily budget of ${use.perDay} ${first} answers for ${use.use} is spent.`,
          409,
        );
    }
    const model = this.deps.laya.currentVersion();
    const key = cacheKey(request, {
      model: `${order.join(",")}|${model}`,
      calibration: this.deps.calibrations.version(),
    });
    const gated = (answers: Record<string, Answer>, provider: ProviderId) =>
      Object.fromEntries(
        Object.entries(answers).map(([name, a]) => {
          const q = request.questions[name];
          return [
            name,
            q === undefined ? a : { ...a, gate: this.gate(use.use, name, q, a, provider, settings, model) },
          ];
        }),
      );
    const fromCache = (seen: CachedDecision): DecisionResult => ({
      id: seen.id,
      answers: gated(seen.answers, "laya"),
      provider: "laya",
      skipped: [],
      trimmed: seen.trimmed,
      estimated: false,
      durationMs: Math.round(performance.now() - started),
      cached: true,
    });
    const cacheable = order[0] === "laya";
    if (cacheable) {
      const seen = this.cache.get(key);
      if (seen !== undefined) return fromCache(seen);
      // The same request is being answered right now: share that answer instead of asking twice.
      const flying = this.inflight.get(key);
      if (flying !== undefined) {
        const shared = await flying;
        if (shared !== undefined) return fromCache(shared);
      }
    }
    let settle: (value: CachedDecision | undefined) => void = () => {};
    const mine = cacheable && !this.inflight.has(key);
    if (mine)
      this.inflight.set(key, new Promise<CachedDecision | undefined>((resolve) => (settle = resolve)));
    try {
      const chain = await runChain(order, this.providers(), request, {
        breaker: this.breaker,
        ...(this.deps.budgets === undefined ? {} : { budgets: this.deps.budgets }),
      });
      const answers = gated(chain.answers, chain.provider);
      const { sent, version, ...rest } = chain;
      const result: DecisionResult = {
        id: this.deps.newId?.() ?? `dec_${randomUUID().slice(0, 8)}`,
        ...rest,
        answers,
        durationMs: Math.round(performance.now() - started),
      };
      const entry: CachedDecision = { id: result.id, answers: chain.answers, trimmed: chain.trimmed };
      if (chain.provider === "laya" && cacheable) this.cache.set(key, entry);
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
      settle(chain.provider === "laya" ? entry : undefined);
      if (chain.provider === "laya") this.askTeacher(request, use, result.id);
      return result;
    } catch (err) {
      settle(undefined);
      throw err;
    } finally {
      if (mine) this.inflight.delete(key);
    }
  }

  /**
   * Whether an answer counts. The rules provider only guesses, so its answers never do. Laya's answer
   * to a slot counts only when the slot is live (a passing eval on this checkpoint) and the answer
   * clears the slot's calibrated bar with every option order agreeing; otherwise it is a shadow.
   * The stand-in agent and Jev keep the base bar.
   */
  private gate(
    use: Use["use"],
    name: string,
    q: Question,
    a: Answer,
    provider: ProviderId,
    settings: DecisionSettings,
    model: string,
  ): Gate {
    if (provider === "rules")
      return { ...gateAnswer(q, a, settings), accepted: false, reason: "the rules only guess" };
    if (provider !== "laya") return baseGate(q, a, settings);
    const slot = this.deps.slots.of(use, name);
    return liveGate({
      slot,
      q,
      a,
      cal: this.deps.calibrations.get(slot.id),
      settings,
      version: model,
      labels: this.labelCount(slot),
    });
  }

  private labelCount(slot: SlotDef): number {
    return bestLabels(this.deps.labels.forUse(slot.use).filter((l) => this.deps.slots.has(slot, l))).length;
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

  /** One decision from the log. */
  get(id: string): DecisionRecord {
    const record = this.deps.log.get(id);
    if (record === undefined) throw new UserError(`There is no decision ${id}.`, 404);
    return record;
  }

  /** The owner says what the right answer was. Kept as a label for the evals and calibration. */
  label(input: {
    id: string;
    question?: string | undefined;
    right: string;
    note?: string | undefined;
  }): DecisionLabel {
    const record = this.get(input.id);
    const names = Object.keys(record.answers);
    const question = input.question ?? (names.length === 1 ? names[0] : undefined);
    if (question === undefined) throw new UserError(`Say which question: ${names.join(", ")}.`);
    if (!names.includes(question)) throw new UserError(`Decision ${input.id} has no question ${question}.`);
    const asked = record.request?.questions[question];
    const options = asked === undefined ? undefined : answerChoices(asked);
    if (options !== undefined && !options.includes(input.right))
      throw new UserError(`${input.right} is not one of ${options.join(", ")}.`);
    this.deps.labels.add({
      decisionId: input.id,
      question,
      label: input.right,
      source: "owner",
      note: input.note,
    });
    this.refitDue();
    const stored = this.deps.labels
      .forDecision(input.id)
      .find((l) => l.question === question && l.source === "owner");
    if (stored === undefined) throw new Error(`The label for ${input.id} cannot be read.`);
    return stored;
  }

  /**
   * Owner only (the command checks). Runs one slot, or all, on its labeled set and its built-in
   * fixtures, and stores the reports. A second call for the same slot while one runs shares it.
   */
  async runEvals(use: string): Promise<EvalReport[]> {
    const wanted =
      use === "all" ? this.deps.slots.all() : [this.deps.slots.byId(use)].filter((s) => s !== undefined);
    if (wanted.length === 0)
      throw new UserError(
        `There is no decision slot ${use}. Slots: ${this.deps.slots
          .all()
          .map((s) => s.id)
          .join(", ")}.`,
        404,
      );
    this.barSettings = await this.settings();
    const reports: EvalReport[] = [];
    for (const slot of wanted) {
      const labeled = bestLabels(
        this.deps.labels.forUse(slot.use).filter((l) => this.deps.slots.has(slot, l)),
      ).length;
      if (labeled > 0) reports.push(await this.runner.run(slot.id, "labels"));
      if (slot.fixtures !== undefined) reports.push(await this.runner.run(slot.id, "fixtures"));
    }
    return reports;
  }

  /** Every slot with its mode, its labels and its last reports, for Hub setup. */
  slots(): SlotStatus[] {
    return this.deps.slots.all().map((slot) => {
      const calibration = this.deps.calibrations.get(slot.id);
      const labels = bestLabels(
        this.deps.labels.forUse(slot.use).filter((l) => this.deps.slots.has(slot, l)),
      ).length;
      const labeled = this.deps.evals.latest(slot.id, "labels");
      const fixtures = this.deps.evals.latest(slot.id, "fixtures");
      const mode = this.modeOf(slot.id, calibration);
      // The weekly eval compares the last two runs on the owner's labels, else on the built-in examples.
      const set = labeled === undefined ? "fixtures" : "labels";
      const drift = regressionOf(
        slot,
        mode === "live",
        this.deps.evals.history(slot.id, 8).filter((r) => r.set === set),
      );
      return {
        slot: slot.id,
        title: slot.title,
        use: slot.use,
        mode,
        labels,
        labelsNeeded: MIN_LABELS,
        target: slot.target,
        ...(calibration === undefined ? {} : { calibration }),
        ...(labeled === undefined ? {} : { labeled }),
        ...(fixtures === undefined ? {} : { fixtures }),
        hasFixtures: slot.fixtures !== undefined,
        ...drift,
      };
    });
  }

  private modeOf(slotId: string, calibration: Calibration | undefined): "shadow" | "live" {
    if (calibration !== undefined) return calibration.mode;
    return this.deps.slots.byId(slotId)?.startMode === "live" ? "live" : "shadow";
  }

  labels(): LabelStore {
    return this.deps.labels;
  }

  link(kind: LinkKind, ref: string, decisionId: string, question: string): void {
    this.deps.labels.link(kind, ref, decisionId, question);
  }

  /** A stronger provider's answer labels the decision it was unsure about. The owner's own label still wins. */
  teach(decisionId: string, question: string, label: string, note?: string): void {
    const use = this.deps.labels.useOf(decisionId);
    if (use === undefined) return;
    // Labels are in the slot's classes ("not-keep" for every kind of drop), as its answers are compared.
    const classed = this.deps.slots.of(use, question).classOf?.(label) ?? label;
    this.deps.labels.add({ decisionId, question, label: classed, source: "teacher", note });
    this.refitDue();
  }

  /**
   * A bigger model labels some of Laya's answers on a slot that asks for it, a few a day (the stand-in
   * agent, within `TEACHER_PER_DAY` answers a day for the use) and only until the slot has plenty of
   * labels. Runs behind the caller and never fails it.
   */
  private askTeacher(request: DecideRequest, use: Use, decisionId: string): void {
    if (use.order?.[0] === "acp" || READ_BY_HAND.has(use.use)) return;
    const names = Object.keys(request.questions).filter((name) => {
      const slot = this.deps.slots.of(use.use, name);
      return slot.teacher === true && this.labelCount(slot) < MIN_LABELS * 3;
    });
    if (names.length === 0) return;
    const ask: DecideRequestInput = {
      state: request.state,
      questions: Object.fromEntries(
        names.flatMap((n) => (request.questions[n] === undefined ? [] : [[n, request.questions[n]]])),
      ),
    };
    void this.decide(ask, {
      use: use.use,
      order: ["acp"],
      perDay: TEACHER_PER_DAY,
      ...(use.task === undefined ? {} : { task: use.task }),
    })
      .then((taught) => {
        if (taught.provider !== "acp") return;
        for (const name of names) {
          const a = taught.answers[name];
          if (a?.gate?.accepted === true)
            this.teach(decisionId, name, String(a.value), "the stand-in agent answered");
        }
      })
      .catch(() => undefined);
  }

  /**
   * Fits every slot that has gathered enough new labels since its last fit, in the background. A fit
   * that passes its target moves the slot to live; one that falls short, or a slot that lost
   * precision, goes back to shadow. Never fails the caller.
   */
  private refitDue(): void {
    for (const slot of this.deps.slots.all()) {
      const n = this.labelCount(slot);
      if (n < MIN_LABELS) continue;
      const last = this.triedAt.get(slot.id) ?? this.deps.calibrations.get(slot.id)?.labels ?? 0;
      if (n - last < REFIT_EVERY) continue;
      this.triedAt.set(slot.id, n);
      void this.settings()
        .then((settings) => {
          this.barSettings = settings;
          return this.runner.run(slot.id, "labels");
        })
        .catch(() => undefined);
    }
  }

  /** The outcome of `ref` is known. The links go: a fact kept once stays kept. */
  resolve(kind: LinkKind, ref: string, label: string, note?: string): void {
    this.deps.labels.resolve(kind, ref, { label, note }, true);
    this.refitDue();
  }

  /** A task reached review: its size decisions get the size it turned out to be. Again at the next review. */
  taskReviewed(task: string, outcome: TaskOutcome): void {
    const size = sizeBucket(outcome);
    this.deps.labels.resolve("task", task, { label: size.label, note: size.note });
    this.refitDue();
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
        const cooling = this.breaker.skipReason(id);
        const reason = cooling ?? (id === "laya" ? layaReason(laya) : await all[id].unavailable());
        return { id, available: reason === undefined, detail: reason ?? "Ready" };
      }),
    );
    return { settings, laya, providers, cache: this.cache.stats() };
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
      if (request.task !== undefined) this.link("task", request.task, result.id, "difficulty");
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
