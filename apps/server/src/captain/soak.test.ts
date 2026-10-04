import {
  AGENT_BLOCKED_COMMANDS,
  type CaptainAction,
  type CaptainRun,
  type CommandName,
  commands,
  type RoomItem,
} from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { toolName } from "../admin/tools.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { ASK, RUNS, TIDY } from "./authority-fixtures.ts";
import { Lanes } from "./lanes.ts";
import type { ApprovalCard, CaptainPorts, NewRepo, PendingFact, QuestionCard, TriageTask } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { PASS_BOUND } from "./rules.ts";
import { CaptainService } from "./service.ts";

/**
 * The soak test of SPEC 5.18 ("No runaway, no loops"). It replays 30 hours of a simulated world in
 * three workspaces (Private on "Runs it", Acme on "Keeps things tidy", Globex on "Only when I ask"):
 * tasks reaching review, bursts of approval cards, agents' questions, memories, new repos, done tasks,
 * restarts in the middle of runs, failures, a "Stop the captain", and the captain's own
 * ships and cards echoing back as events. The lanes run the fake ACP agent, so no token is spent.
 *
 * It fails when a run passes the pass bound, the captain's own card (from its own agent) starts a run, an
 * action repeats, the captain acts while stopped or in a task the owner is in, or anything happens in
 * the workspace set to "Only when I ask". It runs on every merge, in well under a minute.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** A small seeded random source, so a failure replays the same night. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORGS = ["private", "acme", "globex"] as const;
type Org = (typeof ORGS)[number];
const KEY: Record<Org, string> = { private: "PRV", acme: "ACM", globex: "GLX" };

interface SimTask {
  id: string;
  org: Org;
  title: string;
  status: "inbox" | "running" | "review" | "done" | "paused";
  heads: string;
  ready: boolean;
  /** The owner types in it right now. */
  typing?: boolean;
  due?: string;
  priority?: "high" | "normal" | "low";
  updatedAt: string;
}

/** The simulated world the chores read and act in, with every call they make. */
class Sim {
  now = new Date("2026-10-03T00:00:00.000Z");
  readonly tasks = new Map<string, SimTask>();
  cards: (ApprovalCard & { org: Org; done?: boolean })[] = [];
  questions: (QuestionCard & { org: Org; done?: boolean })[] = [];
  facts: (PendingFact & { org: Org; done?: boolean })[] = [];
  repos: (NewRepo & { org: Org; done?: boolean })[] = [];
  cleanable: { org: Org; id: string; done?: boolean }[] = [];
  /** Every call that changes something: the port, the workspace, what it acted on. */
  readonly calls: { port: string; org: string; key: string; at: string }[] = [];
  readonly violations: string[] = [];
  readonly laneTexts: { org: string; text: string }[] = [];
  readonly bell: string[] = [];
  /** Ports that fail for a workspace, and how many more times. */
  readonly failing = new Map<string, number>();
  stopped = false;
  private seq = 0;
  /** Set by the test: the events the world sends back to the captain. */
  echo: {
    review(task: string): void;
    card(task: string, item: RoomItem): void;
  } = { review: () => {}, card: () => {} };
  selfInjected = 0;

  task(org: Org, status: SimTask["status"], extra: Partial<SimTask> = {}): SimTask {
    this.seq += 1;
    const t: SimTask = {
      id: `${KEY[org]}-${this.seq}`,
      org,
      title: `Task ${this.seq}`,
      status,
      heads: `h${this.seq}`,
      ready: true,
      updatedAt: this.now.toISOString(),
      ...extra,
    };
    this.tasks.set(t.id, t);
    return t;
  }

  /** Records a change, and checks the rules that must hold whatever the chore did. */
  act(port: string, org: string, key: string, task?: string): void {
    const at = this.now.toISOString();
    this.calls.push({ port, org, key, at });
    if (this.stopped) this.violations.push(`${port} ${key} while the captain was stopped`);
    if (org === "globex") this.violations.push(`${port} ${key} in Globex, which is set to Only when I ask`);
    const t = task === undefined ? undefined : this.tasks.get(task);
    if (t?.typing === true) {
      this.violations.push(`${port} ${key} while the owner was typing in ${t.id}`);
    }
    const fails = this.failing.get(`${port}:${org}`) ?? 0;
    if (fails > 0) {
      this.failing.set(`${port}:${org}`, fails - 1);
      throw new Error(`${port} failed (simulated)`);
    }
  }

  ports(lanes: Lanes): CaptainPorts {
    const of = (org: string) => [...this.tasks.values()].filter((t) => t.org === org);
    return {
      // The soak world has no memory threads: the follow-ups chore finds nothing.
      followUps: {
        openThreads: () => [],
        task: () => undefined,
        doneSince: async () => [],
        embed: async () => undefined,
        closeThread: () => undefined,
      },
      findings: undefined as unknown as CaptainPorts["findings"],
      ownScope: async () => undefined,
      reviewTasks: async (org) =>
        of(org)
          .filter((t) => t.status === "review")
          .map((t) => ({ id: t.id, title: t.title, heads: t.heads })),
      shipCheck: async (_org, id) => {
        const t = this.tasks.get(id);
        return t?.status === "review" && t.ready
          ? {
              ready: true,
              evidence: "checks pass",
              targets: [{ project: "app", into: "main", base: "main" }],
            }
          : { ready: false, why: "a check fails" };
      },
      ship: async (org, id) => {
        const t = this.tasks.get(id);
        this.act("ship", org, `${id}@${t?.heads}`, id);
        if (t !== undefined) t.status = "done";
        // The captain's own ship comes back as an event: the run it starts finds every key taken.
        this.echo.review(id);
        return { text: `Shipped ${id}`, undoNote: "simulated" };
      },
      mrReady: async () => ({ ok: false as const, why: "simulated: no remote" }),
      openMrs: async () => ({ urls: [], host: "GitHub" }),
      answerTasks: async () => [],
      closeAnswer: async () => undefined,
      askChanges: async () => undefined,
      settleMergeCard: async () => undefined,
      resolveShip: async (org, id) => {
        this.act("resolveShip", org, id, id);
      },
      shipReady: async (org, id) => {
        const t = this.tasks.get(id);
        this.act("shipReady", org, `${id}@${t?.heads}`, id);
        this.echo.review(id);
      },
      approvals: (org) => this.cards.filter((c) => c.org === org && c.done !== true),
      cardVerdict: async (_org, card) =>
        card.command === "tasks.remove"
          ? { decision: "left", why: "Only the owner removes things" }
          : { decision: "approved", why: "A change within the limits" },
      decideCard: async (org, card, verdict) => {
        this.act(`card:${verdict.decision}`, org, `${card.task}:${card.item}`, card.task);
        const found = this.cards.find((c) => c.item === card.item);
        if (found !== undefined) found.done = true;
        // The captain's own card in that task echoes back: it must start nothing.
        this.selfInjected += 1;
        this.echo.card(card.task, {
          id: `approval:self-${card.item}`,
          task: card.task,
          seq: 1,
          at: this.now.toISOString(),
          type: "approval",
          agent: "boss",
          command: "orgs.update",
          risk: "change",
          summary: "the captain's own change",
          input: "{}",
          state: "pending",
        } as RoomItem);
        return { ok: true };
      },
      questions: (org) => this.questions.filter((q) => q.org === org && q.done !== true),
      answer: async (org, card) => {
        this.act("answer", org, `${card.task}:${card.item}`, card.task);
        const found = this.questions.find((q) => q.item === card.item);
        if (found !== undefined) found.done = true;
        return { answered: true };
      },
      laneRest: (org) => lanes.rest(org),
      askLane: async (org, text) => {
        this.act("askLane", org, text.match(/item (\S+)\)/)?.[1] ?? text.slice(0, 40));
        this.laneTexts.push({ org, text });
        const told = await lanes.tell(org, text, "The captain's upkeep asked about a question");
        return told.sent ? { sent: true } : { sent: false, why: told.why };
      },
      pendingFacts: async (org) => this.facts.filter((f) => f.org === org && f.done !== true),
      curate: async (org, fact) => {
        this.act("curate", org, String(fact.id));
        const found = this.facts.find((f) => f.id === fact.id);
        if (found !== undefined) found.done = true;
        return { outcome: fact.id % 3 === 0 ? "pending" : "kept" };
      },
      newRepos: async (org) => this.repos.filter((r) => r.org === org && r.done !== true),
      register: async (org, repo) => {
        this.act("register", org, repo.path);
        const found = this.repos.find((r) => r.path === repo.path);
        if (found !== undefined) found.done = true;
        return {};
      },
      triageTasks: (org): TriageTask[] =>
        of(org)
          .filter((t) => t.status === "inbox")
          .map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            updatedAt: t.updatedAt,
            ...(t.due === undefined ? {} : { due: t.due }),
            ...(t.priority === undefined ? {} : { priority: t.priority }),
          })),
      setPriority: async (org, id, priority) => {
        this.act("setPriority", org, `${id}:${this.tasks.get(id)?.due}`, id);
        const t = this.tasks.get(id);
        if (t !== undefined) t.priority = priority;
      },
      cleanable: async (org) =>
        this.cleanable
          .filter((c) => c.org === org && c.done !== true)
          .map((c) => ({ id: c.id, title: c.id, steps: [`worktree ${c.id}`], dirty: [] })),
      clean: async (org, id) => {
        this.act("clean", org, id);
        const found = this.cleanable.find((c) => c.id === id);
        if (found !== undefined) found.done = true;
        return { removed: [`worktree ${id}`], kept: [] };
      },
      typing: (task) => this.tasks.get(task)?.typing === true,
    };
  }
}

describe("the captain's soak test", () => {
  it("replays 30 hours of events without passing the pass bound, retriggering itself, repeating an action or touching Only when I ask", async () => {
    const sim = new Sim();
    w = await bossWorld({ real: true, runClock: () => sim.now });
    const { h } = w;
    const services = h.majhi.services;
    const must = async (cmd: Promise<{ status: number; body: unknown }>) => {
      const res = await cmd;
      if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    };
    await must(h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" }));
    await must(h.cmd("accounts.create", { id: "claude-own", tool: "claude", org: "private", auth: "login" }));
    await must(
      h.cmd("autonomy.configure", {
        tz: "UTC",
        orgs: {
          // Private runs on its own account, with a small budget so its lane rests.
          private: {
            authority: { ...RUNS, merge: "decide" },
            cap: { cost: 0.04 },
            account: "claude-own",
          },
          acme: { authority: TIDY },
          globex: { authority: ASK },
        },
      }),
    );
    await must(h.cmd("autonomy.start"));

    const repo = new CaptainRepo(services.store.raw);
    const lanes = new Lanes({
      repo,
      store: services.store,
      tasks: services.tasks,
      config: services.config,
      agents: services.agentStore,
      now: () => sim.now,
      rest: (org, account) => services.autonomy.laneRest(org, account),
    });
    const make = () =>
      new CaptainService({
        store: services.store,
        config: services.config,
        events: services.events,
        autonomy: services.autonomy,
        lanes,
        ports: sim.ports(lanes),
        tell: (_key, text) => sim.bell.push(text),
        cancelTurn: async (chat) => {
          await services.tasks.cancel(chat, undefined);
        },
        identity: async () => ({ name: "majhi", email: "majhi@example.com" }),
        ownerCommand: async () => {},
        taskOrg: (task) => sim.tasks.get(task)?.org,
        triggerMs: 0,
        now: () => sim.now,
      });
    let captain = make();
    await captain.boot();
    sim.echo = {
      review: (task) => captain.reviewReached(task),
      card: (task, item) => captain.roomWrote(task, item),
    };
    const rnd = random(7);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
    let cardSeq = 0;
    /** Self events dropped by the instances before a restart. */
    let dropped = 0;
    let factSeq = 0;
    const restarts: string[] = [];
    let stoppedFrom: string | undefined;

    for (let step = 0; step < 180; step++) {
      sim.now = new Date(sim.now.getTime() + 10 * 60_000);
      const iso = sim.now.toISOString();
      // The owner sends or leaves some of what they typed.
      for (const t of sim.tasks.values()) if (t.typing === true && rnd() < 0.5) t.typing = false;

      // A task reaches review in each workspace now and then; some fail their checks.
      if (rnd() < 0.5) {
        const org = pick(ORGS);
        const t = sim.task(org, "review", { ready: rnd() < 0.7 });
        // The owner types in some of them right now.
        if (rnd() < 0.2) t.typing = true;
        captain.reviewReached(t.id);
      }
      // A burst of approval cards in one task.
      if (rnd() < 0.15) {
        const org = pick(ORGS);
        const t = sim.task(org, "running");
        for (let i = 0; i < 25; i++) {
          cardSeq += 1;
          const item = `approval:${cardSeq}`;
          const command = rnd() < 0.2 ? "tasks.remove" : "orgs.update";
          sim.cards.push({
            org,
            task: t.id,
            item,
            agent: "builder",
            command,
            input: {},
            summary: `Card ${cardSeq}`,
          });
          captain.roomWrote(t.id, {
            id: item,
            task: t.id,
            seq: cardSeq,
            at: iso,
            type: "approval",
            agent: "builder",
            command,
            risk: "change",
            summary: `Card ${cardSeq}`,
            input: "{}",
            state: "pending",
          } as RoomItem);
        }
      }
      // Agents ask questions.
      if (rnd() < 0.3) {
        const org = pick(ORGS);
        const t = sim.task(org, "running");
        cardSeq += 1;
        const item = `choice:${cardSeq}`;
        sim.questions.push({
          org,
          task: t.id,
          item,
          agent: "builder",
          // Every other card is a prompt for a read tool of majhi, which a rule settles; the rest are for the lane.
          ...(cardSeq % 2 === 0
            ? {
                kind: "permission" as const,
                text: "mcp__majhi-containers__logs",
                options: [
                  { id: "once", label: "Allow once", effect: "allow" as const },
                  { id: "no", label: "Reject", effect: "deny" as const },
                ],
              }
            : {
                kind: "choice" as const,
                text: `Which way for ${t.id}?`,
                options: [
                  { id: "a", label: "The first way" },
                  { id: "b", label: "The second way" },
                ],
              }),
        });
        captain.roomWrote(t.id, {
          id: item,
          task: t.id,
          seq: cardSeq,
          at: iso,
          type: "choice",
          agent: "builder",
          question: `Which way for ${t.id}?`,
          options: [
            { id: "a", label: "The first way" },
            { id: "b", label: "The second way" },
          ],
          state: "pending",
        } as RoomItem);
      }
      // Memories wait, repos appear, tasks get done, tasks get due.
      if (rnd() < 0.3) {
        factSeq += 1;
        sim.facts.push({ org: pick(ORGS), id: factSeq, text: `A lesson ${factSeq}` });
      }
      if (rnd() < 0.05) {
        const org = pick(ORGS);
        sim.repos.push({
          org,
          path: `/work/${org}/repo-${step}`,
          name: `repo-${step}`,
          aliases: [],
          id: `repo-${step}`,
          base: "main",
          remotes: [],
        });
        captain.reposSeen([org]);
      }
      if (rnd() < 0.1) {
        const org = pick(ORGS);
        sim.cleanable.push({ org, id: sim.task(org, "done").id });
      }
      if (rnd() < 0.1) sim.task(pick(ORGS), "inbox", { due: iso.slice(0, 10) });
      // A duplicate title, and a task nobody touched for 40 days.
      if (step === 20) {
        sim.task("acme", "inbox", { title: "Fix the login" });
        sim.task("acme", "inbox", { title: "fix the  login" });
        sim.task("private", "inbox", { updatedAt: "2026-08-20T00:00:00.000Z" });
      }

      // Failures: Acme's cleanup fails twice in a row and turns off; Private's ship fails once.
      if (step === 30) {
        sim.failing.set("clean:acme", 5);
        for (let i = 0; i < 3; i++) sim.cleanable.push({ org: "acme", id: sim.task("acme", "done").id });
      }
      if (step === 40) sim.failing.set("ship:private", 1);

      // Restarts, one of them in the middle of a run: a crash leaves the run open in the database.
      if (step % 47 === 46) {
        if (step === 93)
          repo.openRun({
            org: "private",
            chore: "ship",
            day: iso.slice(0, 10),
            at: iso,
            trigger: "Hourly check",
          });
        dropped += captain.runner.selfDropped;
        captain.close();
        restarts.push(iso);
        captain = make();
        await captain.boot();
      }
      // Stop the captain for two hours, then resume it and turn autonomous mode back on.
      if (step === 60) {
        await captain.settled();
        await captain.stop();
        sim.stopped = true;
        stoppedFrom = iso;
      }
      if (step === 72) {
        sim.stopped = false;
        await captain.resume();
        await must(h.cmd("autonomy.start"));
      }

      await captain.sweepNow();
      await captain.settled();
    }
    await services.runs.idle();

    // Nothing broke a rule the chores could not see.
    expect(sim.violations).toEqual([]);
    expect(stoppedFrom).toBeDefined();
    expect(restarts.length).toBeGreaterThanOrEqual(3);

    // The captain's own cards never started a run or joined one: every one was dropped. Its own ships echo
    // back as review events; the runs they start find every key taken, which the no-repeat check above covers.
    expect(sim.selfInjected).toBeGreaterThan(10);
    expect(dropped + captain.runner.selfDropped).toBe(sim.selfInjected);
    const runs: CaptainRun[] = repo.allRuns();
    const actions: CaptainAction[] = repo.allActions();

    // No run passed the pass bound, and none is left open.
    expect(runs.filter((r) => r.status === "running")).toEqual([]);
    for (const r of runs) {
      expect(r.tokens).toBeLessThanOrEqual(PASS_BOUND.tokens);
      const minutes = (Date.parse(r.endedAt ?? r.startedAt) - Date.parse(r.startedAt)) / 60_000;
      expect(minutes).toBeLessThanOrEqual(PASS_BOUND.minutes);
    }
    // The restart cut a run short; it ended as stopped.
    expect(runs.some((r) => r.status === "stopped" && r.note === "majhi restarted during the run")).toBe(
      true,
    );

    // No action repeated: every change happened once per thing it acted on.
    const seen = new Set<string>();
    const repeats = sim.calls.filter((c) => {
      const key = `${c.port}:${c.key}`;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    // A failed step may be tried again in a later run; nothing else may repeat.
    expect(
      repeats.filter((c) => !(c.port === "ship" || c.port === "clean")).map((c) => `${c.port}:${c.key}`),
    ).toEqual([]);
    const doneShips = actions.filter((a) => a.chore === "ship" && a.outcome === "done").map((a) => a.task);
    expect(new Set(doneShips).size).toBe(doneShips.length);

    // Nothing in Globex: no call, no run, no line, no lane.
    expect(sim.calls.filter((c) => c.org === "globex")).toEqual([]);
    expect(runs.filter((r) => r.org === "globex")).toEqual([]);
    expect(actions.filter((a) => a.org === "globex")).toEqual([]);
    expect(lanes.chat("globex")).toBeUndefined();

    // Acme keeps things tidy: it asked before shipping and never shipped.
    expect(sim.calls.filter((c) => c.org === "acme" && c.port === "ship")).toEqual([]);
    expect(sim.calls.some((c) => c.org === "acme" && c.port === "shipReady")).toBe(true);
    expect(sim.calls.some((c) => c.org === "private" && c.port === "ship")).toBe(true);

    // Two failures in a row turned Acme's cleanup off, told the owner, and it did nothing more.
    expect(repo.chore("acme", "cleanup").offAt).toBeDefined();
    expect(sim.bell.some((b) => b.includes('turned "Cleanup" off after 2 failures in a row'))).toBe(true);
    const offAt = repo.chore("acme", "cleanup").offAt ?? "";
    expect(sim.calls.filter((c) => c.port === "clean" && c.org === "acme" && c.at > offAt)).toEqual([]);

    // Each lane heard only its own workspace's tasks.
    for (const { org, text } of sim.laneTexts) {
      const others = ORGS.filter((o) => o !== org).map((o) => `${KEY[o]}-`);
      for (const prefix of others) expect(text, `${org} lane`).not.toContain(prefix);
    }
    expect(sim.laneTexts.length).toBeGreaterThan(0);
    // The lane rested once Private's small budget was used; the rule table's answers went on.
    expect(
      actions.some((a) => a.org === "private" && a.reason.startsWith("The captain is resting here")),
    ).toBe(true);
    expect(sim.calls.filter((c) => c.org === "private" && c.port === "answer").length).toBeGreaterThan(0);

    // Each lane reads its own workspace only: every read command an agent may call, from the command table.
    const reads = (Object.keys(commands) as CommandName[]).filter(
      (c) =>
        commands[c].risk === "read" &&
        !AGENT_BLOCKED_COMMANDS.has(c) &&
        commands[c].input.safeParse({}).success,
    );
    const foreign: Record<string, RegExp[]> = {
      acme: [/globex/i, /\bLOCAL-\d/, /\bPRV-\d/],
      private: [/globex/i, /\bACM-\d/],
    };
    for (const { org, chat } of lanes.all()) {
      const leaks: string[] = [];
      for (const command of reads) {
        const res = await services.admin.call({ task: chat, agent: "boss" }, toolName(command), {
          reason: "reading",
        });
        if (res.isError) continue;
        const hit = (foreign[org] ?? [/globex/i]).find((re) => re.test(res.text));
        if (hit !== undefined) leaks.push(`${org} ${command}: ${res.text.match(hit)?.[0]}`);
      }
      expect(leaks, `${org} lane`).toEqual([]);
    }
    expect(lanes.all().length).toBeGreaterThanOrEqual(2);

    // The day's summary line is there for each workspace that did something.
    const status = await captain.status();
    expect(status.orgs.find((o) => o.org === "globex")?.summary).toBe("");
    captain.close();
  }, 240_000);
});
