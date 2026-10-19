import { type Authority, type AutonomyMode, type Playbook, PlaybookSchema, PRIVATE } from "@majhi/shared";
import { describe, expect, it, vi } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { CaptainRepo } from "../captain/repo.ts";
import type { ChoreRunner, Workspace } from "../captain/runner.ts";
import { FindingsRepo } from "../findings/repo.ts";
import { FindingsService } from "../findings/service.ts";
import { Store } from "../store/index.ts";
import { BUILTIN, Catalog } from "./catalog.ts";
import { GoalsService } from "./goals.ts";
import { PlaybookRepo } from "./repo.ts";
import { RULES_RUNNERS, type RulesRunner } from "./rules.ts";
import { CAPTAIN_RUN_MINUTES, PlaybookService } from "./service.ts";

/** The playbook scheduler: single flight, backoff, quiet hours, Autonomous off, budgets, reports. */

const T0 = new Date("2026-10-04T10:00:00.000Z");
const MIN = 60_000;

const rulesPlaybook = (over: Partial<Playbook> = {}): Playbook =>
  PlaybookSchema.parse({
    id: "t-rules",
    name: "Test check",
    pack: "ops",
    purpose: "A check for tests.",
    trigger: { cadence: { kind: "every", minutes: 5 }, events: [] },
    inputs: ["nothing"],
    steps: "Check.",
    outputs: ["finding"],
    cost: { tier: "rules", tokens: 0 },
    enabledByDefault: false,
    turnOn: "Runs the test check.",
    runner: { kind: "rules", id: "t" },
    ...over,
  });

const captainPlaybook = (over: Partial<Playbook> = {}): Playbook =>
  PlaybookSchema.parse({
    id: "t-captain",
    name: "Test sweep",
    pack: "engineering",
    purpose: "A sweep for tests.",
    trigger: { cadence: { kind: "every", minutes: 60 }, events: [] },
    inputs: ["the repo"],
    steps: "Look at the repo and report what is wrong.",
    outputs: ["finding", "draft"],
    cost: { tier: "small", tokens: 1_000 },
    enabledByDefault: false,
    turnOn: "Runs the test sweep.",
    runner: { kind: "captain" },
    settings: [{ key: "notes", label: "Notes", hint: "" }],
    ...over,
  });

function setup(extra: { rules?: RulesRunner; preflight?: (org: string) => string | undefined } = {}) {
  const db = new Store(":memory:").raw;
  const clock = { at: new Date(T0) };
  const state = {
    mode: "on" as AutonomyMode,
    authority: RUNS as Authority,
    rest: undefined as string | undefined,
    laneRest: undefined as string | undefined,
    tokens: 0,
  };
  const woke: string[] = [];
  const findings = new FindingsService({
    repo: new FindingsRepo(db),
    now: () => clock.at,
    projectOrg: async () => undefined,
    taskStatus: () => undefined,
    createTask: async () => ({ id: "ACM-1" }),
  });
  const goals = new GoalsService({
    db,
    now: () => clock.at,
    knownOrg: async (o) => o === PRIVATE || o === "acme" || o === "globex",
  });
  const catalog = new Catalog([
    ...BUILTIN,
    rulesPlaybook(),
    captainPlaybook(),
    rulesPlaybook({ id: "t-readonly", readOnly: true }),
    captainPlaybook({ id: "t-needs", needs: "Needs a sensor that is not built." }),
  ]);
  const runs: { rules: number } = { rules: 0 };
  const rules: Record<string, RulesRunner> = {
    ...RULES_RUNNERS,
    t: extra.rules ?? {
      run: async () => {
        runs.rules += 1;
        return { findings: 0, note: "fine" };
      },
    },
  };
  const tells: { org: string; text: string }[] = [];
  const cancelled: string[] = [];
  const startNow = vi.fn(async () => ({
    ran: true as const,
    overCap: false,
    done: Promise.resolve("done" as const),
  }));
  const captainRepo = new CaptainRepo(db);
  const workspace = async (org: string): Promise<Workspace | undefined> =>
    org === PRIVATE || org === "acme" || org === "globex"
      ? {
          org,
          name: org === PRIVATE ? "Private" : org,
          mode: state.mode,
          authority: state.authority,
          rules: undefined,
          tz: "UTC",
          day: clock.at.toISOString().slice(0, 10),
          ...(state.rest === undefined ? {} : { rest: state.rest }),
        }
      : undefined;
  const owner: string[] = [];
  const service = new PlaybookService({
    repo: new PlaybookRepo(db),
    catalog,
    captain: {
      workspace,
      repo: captainRepo,
      runner: { running: () => false, startNow } as unknown as ChoreRunner,
      choreOn: async () => undefined,
    },
    findings,
    goals,
    orgs: async () => [PRIVATE, "acme"],
    lane: {
      chat: () => "CHAT-1",
      tell: async (org, text) => {
        if (state.laneRest !== undefined) return { sent: false, why: state.laneRest };
        tells.push({ org, text });
        return { sent: true, chat: "CHAT-1" };
      },
    },
    laneTokens: () => state.tokens,
    cancelTurn: async (chat) => void cancelled.push(chat),
    mode: () => state.mode,
    rules,
    ...(extra.preflight === undefined ? {} : { preflight: { "t-captain": extra.preflight } }),
    tellOwner: (_key, text) => void owner.push(text),
    now: () => clock.at,
  });
  const advance = (ms: number) => {
    clock.at = new Date(clock.at.getTime() + ms);
  };
  return {
    service,
    state,
    clock,
    advance,
    runs,
    tells,
    cancelled,
    findings,
    goals,
    woke,
    owner,
    startNow,
    catalog,
  };
}

const on = (t: ReturnType<typeof setup>, id: string, org = "acme") =>
  t.service.update({ org, id, enabled: true });

describe("a captain playbook", () => {
  it("ends a run that reached its token budget: the turn is cancelled, the run is capped, it backs off", async () => {
    const t = setup();
    await on(t, "t-captain");
    await t.service.update({ org: "acme", id: "t-captain", cadence: { kind: "every", minutes: 5 } });
    await t.service.sweep();
    const [open] = t.service.runs("acme", "t-captain", 5);
    t.state.tokens = 999;
    await t.service.sweep();
    expect(t.cancelled).toEqual([]);
    t.state.tokens = 1_400;
    t.advance(MIN);
    await t.service.sweep();
    expect(t.cancelled).toEqual(["CHAT-1"]);
    expect(t.service.runs("acme", "t-captain", 5)[0]).toMatchObject({
      status: "capped",
      tokens: 1_400,
    });
    // The late report is refused; the playbook waits out its backoff (15 minutes from the cap).
    await expect(
      t.service.report(
        { run: open?.id ?? 0, outcome: "done", summary: "x" },
        { kind: "captain", org: "acme" },
      ),
    ).rejects.toThrow();
    t.state.tokens = 0;
    t.advance(10 * MIN);
    await t.service.sweep();
    expect(t.tells).toHaveLength(1);
    t.advance(6 * MIN);
    await t.service.sweep();
    expect(t.tells).toHaveLength(2);
  });
});
