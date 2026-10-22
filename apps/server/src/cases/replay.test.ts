import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatEnvelope, DeployRunStep, OwnerDecision, RoomItem, TaskSummary } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONN, envelope } from "../chat/testing/world.ts";
import type { RemoteRunFn } from "../connections/remote.ts";
import { discoverEnvironments } from "../deploy/discover.ts";
import { acmeShopCi } from "../deploy/testing/acme-shop.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { git } from "../testing/fixtures.ts";

/**
 * The replay of the outage that started the case flow (docs/briefs/case-flow.md): a client says slips are not
 * printed and orders do not reach the courier, twice, two minutes apart, while the owner never clicks. A scripted
 * captain (the fake ACP agent) works it against a fake host whose celery worker is stuck until it is restarted.
 */

const ROOM_CHAT = "-700";
const FLAGS = { promisedTime: false, money: false, security: false, severalClients: false };

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
  vi.restoreAllMocks();
});

/** A host with a worker that holds every slot until it is restarted. */
function stuckHost(ran: string[]): RemoteRunFn {
  let restarted = false;
  return async (_alias, command) => {
    ran.push(command);
    if (command.startsWith("docker restart")) {
      restarted = true;
      return { code: 0, output: "acme-worker" };
    }
    if (command.startsWith("docker ps"))
      return {
        code: 0,
        output: restarted ? "acme-worker  Up 2 seconds (healthy)" : "acme-worker  Up 3 days (unhealthy)",
      };
    if (command.startsWith("docker logs"))
      return {
        code: 0,
        output: restarted
          ? "celery@worker ready."
          : "all 3 slots busy: courier.status_sweep, courier.status_sweep, courier.status_sweep",
      };
    if (command.startsWith("curl"))
      return restarted ? { code: 0, output: "ok" } : { code: 22, output: "curl: (22) HTTP 500" };
    return { code: 127, output: "not found" };
  };
}

async function replayWorld(remote: RemoteRunFn) {
  w = await bossWorld({ real: true, connectionsRemote: remote });
  const { h } = w;
  const services = h.majhi.services;
  const parts = services.chatParts;
  await h.cmd("authority.set", { org: "acme", level: "routine", fix: "ships" });
  const made = await h.cmd("connections.create", {
    org: "acme",
    id: "acme-host",
    type: "ssh",
    name: "Host",
    fields: { alias: "deploy@10.0.0.5" },
  });
  expect(made.status).toBe(200);
  // The chat of the client, linked to the workspace; its replies are recorded, not sent anywhere.
  const sent: string[] = [];
  vi.spyOn(parts.hub, "send").mockImplementation(async (_app, _account, _target, message) => {
    sent.push(JSON.stringify(message.body));
    return { message: String(900 + sent.length) };
  });
  const opened = parts.rooms.open({
    app: "telegram",
    account: CONN.account,
    chat: ROOM_CHAT,
    title: "Orders for Initech",
    kind: "group",
    holder: "captain",
    sendAs: "bot",
  });
  const room = await parts.rooms.link(opened.id, "acme");
  await h.cmd("chat.settingsSet", { room: room.id, replyWhen: "every" });
  const lane = await services.lanes.ensure("acme", "reacting");
  const results = join(lane.folder, "CAPTAIN_SCRIPT_RESULTS.jsonl");
  return { h, services, parts, room, lane, sent, results };
}

type Replay = Awaited<ReturnType<typeof replayWorld>>;

const step = (tool: string, args: Record<string, unknown> = {}, server?: string) => ({
  tool,
  args,
  ...(server === undefined ? {} : { server }),
});
const ssh = (command: string) => step("ssh", { connection: "acme-host", command }, "majhi-connections");

async function script(r: Replay, steps: ReturnType<typeof step>[], where: "lane" | "all" = "lane") {
  await writeFile(
    join(where === "lane" ? r.lane.folder : dirname(r.lane.folder), "CAPTAIN_SCRIPT.json"),
    JSON.stringify({ rules: [{ when: "Client chat", flags: "", steps }] }),
  );
}

/** Ana's message, as Telegram delivers it. */
function ana(over: NonNullable<Parameters<typeof envelope>[0]>): ChatEnvelope {
  return envelope({
    chatId: ROOM_CHAT,
    chat: { title: "Orders for Initech", kind: "group", people: 3 },
    sender: { id: "u-ana", name: "Ana", bot: false, verified: true },
    ...over,
  });
}

async function say(r: Replay, text: string, message: string, at: Date): Promise<void> {
  await r.parts.ingest.deliver(CONN, ana({ text, message, at: at.toISOString() }));
  await r.parts.ingest.idle();
}

/** What the scripted captain's calls answered, in order. */
async function lines(r: Replay): Promise<{ tool: string; isError: boolean; text: string }[]> {
  return (await readFile(r.results, "utf8").catch(() => ""))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { tool: string; isError: boolean; text: string });
}

/** The desk wakes the captain, and the replay waits for its scripted turn to end. */
async function wakeAndWait(r: Replay, calls: number) {
  await r.parts.desk.flush(r.room.id);
  await w?.until(async () => (await lines(r)).length >= calls, "the scripted turn");
  await r.services.runs.idle(r.lane.id);
  return lines(r);
}

const owner = async (r: Replay) => ({
  decisions: ((await r.h.cmd("decisions.list", {})).body.decisions as OwnerDecision[]).filter(
    (d) => d.org === "acme",
  ),
  tasks: (await r.h.cmd("tasks.list", { includeDone: true })).body as
    | TaskSummary[]
    | { tasks: TaskSummary[] },
});

const REPLY_1 = "We found it: the order worker is jammed. We are fixing it now.";
const REPLY_2 = "Fixed, please try again.";

/** What the captain does for the outage: read, tell the client, restart the worker once, check, close. */
function fixSteps(r: Replay) {
  return [
    step("majhi_chat_openIncident", {
      room: r.room.id,
      found: "Slips fail and the courier call is not made.",
    }),
    step("majhi_case_status", { now: "Reading the worker on the host" }),
    ssh("docker ps"),
    ssh("docker logs --tail 50 acme-worker"),
    // What a case never does: a plan, a task, a bug report.
    step("majhi_tasks_create", { text: "fix the worker", reason: "a try", ownerAsked: false }),
    step("majhi_captain_reportBug", { title: "a try", details: "a try", reason: "a try" }),
    step("majhi_chat_reply", { room: r.room.id, text: REPLY_1, ...FLAGS }),
    step("majhi_case_status", { now: "Restarting the worker" }),
    ssh("docker restart acme-worker"),
    ssh("docker ps"),
    ssh("curl -sf localhost:8000/slips/health"),
    step("majhi_case_followUp", { text: "Stop the courier status sweep from filling every slot" }),
    step("majhi_case_close", {
      summary: [
        "Slips and courier orders failed.",
        "The courier status sweep held all 3 slots of the order worker.",
        "Restarted the worker once; it took new work at once.",
        "The slips check answers again.",
      ].join("\n"),
      tell: { text: REPLY_2, ...FLAGS },
    }),
  ];
}

describe("the case replay", () => {
  it("opens one case for two messages, reads and restarts without a card, checks it works, and closes it", async () => {
    const ran: string[] = [];
    const r = await replayWorld(stuckHost(ran));
    const now = new Date();
    await say(r, "print slips are not generated and orders cannot be sent to the courier", "1", now);
    await say(r, "still the same: no slips", "2", new Date(now.getTime() + 120_000));
    await script(r, fixSteps(r));
    const done = await wakeAndWait(r, 13);

    // One case, in the workspace, and nothing else: no task, no bug.
    const all = (await r.h.cmd("tasks.list", { includeDone: true })).body as TaskSummary[];
    const work = all.filter((t) => t.lane !== true && t.chat !== true);
    expect(work.map((t) => [t.typing?.type, t.org, t.status])).toEqual([["incident", "acme", "done"]]);
    expect(
      done.filter((d) => d.tool === "majhi_tasks_create" || d.tool === "majhi_captain_reportBug"),
    ).toEqual([expect.objectContaining({ isError: true }), expect.objectContaining({ isError: true })]);
    // Reads and the restart ran with no card; the restart once; a read shows slips work.
    const pending = (await r.h.cmd("room.items", { task: r.lane.id, limit: 200 })).body.items as RoomItem[];
    expect(pending.filter((i) => i.type === "permission" && i.state === "pending")).toEqual([]);
    expect(ran.filter((c) => c.startsWith("docker restart"))).toEqual(["docker restart acme-worker"]);
    expect(ran.at(-1)).toBe("curl -sf localhost:8000/slips/health");
    expect(done.find((d) => d.text.includes("slips/health"))?.text).toContain("exit 0");
    // The client got two messages, the owner has nothing to decide, and the case says what happened.
    expect(r.sent).toHaveLength(2);
    expect((await owner(r)).decisions).toEqual([]);
    const fields = all.find((t) => t.typing?.type === "incident")?.case;
    expect(fields).toMatchObject({
      followUps: [{ text: "Stop the courier status sweep from filling every slot" }],
      stopped: false,
    });
    expect(fields?.summary?.split("\n")).toHaveLength(4);
  });
});

describe("the case replay when the fix needs a code deploy", () => {
  it("ends with one card, tells the client it is being worked on, and takes a later message into the same case", async () => {
    const ran: string[] = [];
    const r = await replayWorld(stuckHost(ran));
    const now = new Date();
    await say(r, "print slips are not generated and orders cannot be sent to the courier", "1", now);
    const ask = (question: string) =>
      step("majhi_case_ask", {
        question,
        options: [
          { id: "deploy", label: "Deploy" },
          { id: "wait", label: "Not now" },
        ],
      });
    const rules = [
      {
        when: "The owner answered a card",
        flags: "",
        steps: [step("majhi_case_status", { now: "Deploying" })],
      },
      {
        when: "<case id=",
        flags: "",
        steps: [step("majhi_case_status", { now: "Looked at the new message" })],
      },
      {
        when: "Client chat",
        flags: "",
        steps: [
          step("majhi_chat_openIncident", {
            room: r.room.id,
            found: "Slips fail and the courier call is not made.",
          }),
          ssh("docker logs --tail 50 acme-worker"),
          step("majhi_chat_reply", {
            room: r.room.id,
            text: "We found the cause in our code. A fix is being worked on.",
            ...FLAGS,
          }),
          ask("Deploy fix X to Acme?"),
          // One card at a time.
          ask("Deploy fix Y to Acme?"),
          // The same read again, with nothing changed since, is answered from the record.
          ssh("docker logs --tail 50 acme-worker"),
          step("majhi_case_status", { now: "Waiting for your answer on the deploy" }),
        ],
      },
    ];
    await writeFile(join(r.lane.folder, "CAPTAIN_SCRIPT.json"), JSON.stringify({ rules }));
    const first = await wakeAndWait(r, 7);
    expect(first[4]?.isError).toBe(true);
    expect(first[5]?.text).toContain("Not run again");

    // Exactly one card, with its buttons, and the client was told it is being worked on.
    let cards = (await owner(r)).decisions;
    expect(cards.map((d) => [d.title, d.options.map((o) => o.label)])).toEqual([
      [expect.stringContaining("Deploy fix X to Acme?"), ["Deploy", "Not now"]],
    ]);
    expect(r.sent).toHaveLength(1);

    // A later message of the same chat joins the case: no case, no task and no reply of its own, and no second card.
    await say(r, "any news?", "2", new Date(now.getTime() + 120_000));
    await r.parts.desk.flush(r.room.id);
    await w?.until(async () => (await lines(r)).length >= 8, "the join turn");
    await r.services.runs.idle(r.lane.id);
    const all = (await r.h.cmd("tasks.list", { includeDone: true })).body as TaskSummary[];
    const work = all.filter((t) => t.lane !== true && t.chat !== true);
    expect(work.map((t) => [t.typing?.type, t.status])).toEqual([["incident", "running"]]);
    const said = r.services.store.room
      .page(r.room.id, 20)
      .items.flatMap((i) => (i.type === "client" && i.us !== true ? [i.outcome?.why ?? ""] : []));
    expect(said.toSorted()).toEqual([
      expect.stringContaining("Joined case ACM-"),
      expect.stringContaining("Opened incident ACM-"),
    ]);
    expect(r.sent).toHaveLength(1);
    cards = (await owner(r)).decisions;
    expect(cards).toHaveLength(1);

    // The owner's pick reaches the captain, and the card is gone.
    await r.h.cmd("decisions.answer", { id: cards[0]?.id, option: "deploy" });
    await w?.until(async () => (await lines(r)).length >= 9, "the answer turn");
    await r.services.runs.idle(r.lane.id);
    expect((await owner(r)).decisions).toEqual([]);
  });
});

/** The owner's own path, recorded: the phone push and the Telegram message. */
function ownerLine(r: Replay): string[] {
  const told: string[] = [];
  vi.spyOn(r.services.ops, "tellOwner").mockImplementation(async (title, text) => {
    told.push(`${title}: ${text}`);
  });
  return told;
}

const MIN = 60_000;

describe("the case replay when the captain's lane is down", () => {
  it("heals a lane that is paused with a sign-in error and has lost its folder, answers the client, and never tells the owner", async () => {
    const ran: string[] = [];
    const r = await replayWorld(stuckHost(ran));
    const told = ownerLine(r);
    const t0 = new Date(Date.now() - 3 * MIN);
    // The lane stopped on a sign-in error, and its folder is gone. The script waits in the folder of all tasks.
    await r.services.tasks.apply(
      r.lane.id,
      {
        type: "holdPlaced",
        hold: { cause: "error", at: t0.toISOString(), phase: "start", error: "The sign-in check failed" },
      },
      { ctx: { by: "majhi", why: "The sign-in check failed", reason: "error" } },
    );
    await rm(r.lane.folder, { recursive: true, force: true });
    await script(r, fixSteps(r), "all");
    await say(r, "print slips are not generated and orders cannot be sent to the courier", "1", t0);
    await say(r, "still the same: no slips", "2", new Date(t0.getTime() + 2 * MIN));

    // The wake never reached the lane. The watchdog looks: the messages waited three minutes and no turn runs.
    await r.services.watchdog.sweep(new Date());
    await r.parts.desk.flush(r.room.id);
    await w?.until(async () => (await lines(r)).length >= 13, "the healed captain's turn");
    await r.services.runs.idle(r.lane.id);

    const all = (await r.h.cmd("tasks.list", { includeDone: true })).body as TaskSummary[];
    const work = all.filter((t) => t.lane !== true && t.chat !== true);
    expect(work.map((t) => [t.typing?.type, t.status])).toEqual([["incident", "done"]]);
    expect(r.sent).toHaveLength(2);
    expect(told).toEqual([]);
    expect((await owner(r)).decisions).toEqual([]);
    // The room says majhi restarted the captain, with the cause: the case's room once the captain's lines about it
    // are tagged to it, the lane's room before.
    const caseId = work[0]?.id ?? "";
    const items = async (task: string) =>
      (await r.h.cmd("room.items", { task, limit: 200 })).body.items as RoomItem[];
    const said = [...(await items(caseId)), ...(await items(r.lane.id))].flatMap((i) =>
      i.type === "system" && i.text.startsWith("majhi restarted the captain") ? [i.text] : [],
    );
    expect(said).toEqual([expect.stringContaining("majhi restarted the captain: The sign-in check failed")]);
  });

  it("tells the owner once at ten minutes when the heals keep failing, and tells the client we are looking into it", async () => {
    const r = await replayWorld(stuckHost([]));
    const told = ownerLine(r);
    const t0 = new Date(Date.now() - 20 * MIN);
    const lane = r.lane.id;
    await r.services.tasks.apply(
      lane,
      {
        type: "holdPlaced",
        hold: {
          cause: "error",
          at: t0.toISOString(),
          phase: "start",
          error: "docker refused to start the runner",
        },
      },
      { ctx: { by: "majhi", why: "docker refused", reason: "error" } },
    );
    // Every resume fails again at once.
    const starts: string[] = [];
    const start = r.services.tasks.start.bind(r.services.tasks);
    vi.spyOn(r.services.tasks, "start").mockImplementation(async (id, by, options) => {
      if (id !== lane) return start(id, by, options);
      starts.push(by ?? "owner");
      throw new Error("docker refused to start the runner");
    });
    await say(r, "print slips are not generated and orders cannot be sent to the courier", "1", t0);
    await r.parts.desk.flush(r.room.id);

    for (const minute of [2.5, 3.6, 7, 9, 10.5, 11, 14])
      await r.services.watchdog.sweep(new Date(t0.getTime() + minute * MIN));

    // Three resumes, no more, and one alert that says what was tried.
    expect(starts.filter((by) => by === "boss")).toHaveLength(3);
    expect(told).toEqual([
      expect.stringContaining(
        "Ana wrote 10 min ago in Orders for Initech; the captain could not start: docker refused",
      ),
    ]);
    expect(told[0]).toContain("tried: resume ×3");
    // The client has the fixed words, once.
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain("We're looking into it.");
  });
});

/** The cases of the workspace, other than the captain's lane and the chats. */
async function work(r: Replay): Promise<TaskSummary[]> {
  const all = (await r.h.cmd("tasks.list", { includeDone: true })).body as TaskSummary[];
  return all.filter((t) => t.lane !== true && t.chat !== true);
}

describe("a helper in a case", () => {
  it("never messages the client, asks the owner or files a task, and a second helper is refused while one works", async () => {
    const r = await replayWorld(stuckHost([]));
    await say(r, "print slips are not generated and orders cannot be sent to the courier", "1", new Date());
    await script(r, [
      step("majhi_chat_openIncident", {
        room: r.room.id,
        found: "Slips fail and the courier call is not made.",
      }),
    ]);
    await wakeAndWait(r, 1);
    const caseId = (await work(r))[0]?.id ?? "";
    const { cases, admin, coordinator } = r.services;

    // One helper, one job. A second job while it works is refused.
    const started = await cases.help(r.lane.id, {
      case: caseId,
      job: "Read the worker's code and say what holds its slots",
    });
    expect(started.note).toContain("@acme-builder");
    await expect(cases.help(r.lane.id, { case: caseId, job: "Another job" })).rejects.toThrow(
      /One helper at a time/,
    );

    // What a helper may not do is refused where each call is made: a client message, a card for the owner, a task.
    const helper = { agent: "acme-builder", task: caseId };
    for (const [tool, args] of [
      ["majhi_chat_reply", { room: r.room.id, text: "Hello", ...FLAGS }],
      ["majhi_tasks_create", { text: "fix the worker", reason: "a try", ownerAsked: false }],
      [
        "majhi_case_ask",
        {
          question: "Deploy?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    ] as const) {
      expect(await admin.call(helper, tool, args)).toMatchObject({
        isError: true,
        text: expect.stringContaining("helper"),
      });
    }
    await expect(
      coordinator.postAskCard(caseId, "acme-builder", [
        { id: "q", question: "Merge it?", options: [{ id: "y", label: "Yes" }], freeText: false },
      ]),
    ).rejects.toThrow(/never asks the owner/);
    expect(
      cases.beforeCommand(caseId, "acme-host: docker restart acme-worker", "write", undefined),
    ).toMatchObject({ how: "refuse" });

    // Nothing reached the client or the owner, and no task was made.
    await r.services.runs.idle(caseId);
    expect(r.sent).toEqual([]);
    expect((await owner(r)).decisions).toEqual([]);
    expect((await work(r)).map((t) => t.typing?.type)).toEqual(["incident"]);
  });
});

const PREVIOUS = "1111111111111111111111111111111111111111";
const DEPLOY_RUNS: DeployRunStep[] = [
  { kind: "github-workflow", remote: "origin", workflow: "deploy.yml", ref: "base" },
];

/** A host whose courier job has a bug in the code: nothing a restart clears, and the slips check works once fixed. */
function codeBugHost(fixed: { value: boolean }): RemoteRunFn {
  return async (_alias, command) => {
    if (command.startsWith("docker logs"))
      return { code: 0, output: "KeyError: 'carrier' in courier.status_sweep, again and again" };
    if (command.startsWith("curl"))
      return fixed.value ? { code: 0, output: "ok" } : { code: 22, output: "curl: (22) HTTP 500" };
    return { code: 127, output: "not found" };
  };
}

describe("the case replay when the fix needs code", () => {
  it("has a helper write it, deploys it, reads the symptom and closes, with no card and no task", async () => {
    const fixed = { value: false };
    const r = await replayWorld(codeBugHost(fixed));
    const { services } = r;
    // The project went live before through a run majhi can repeat: that is the deploy path the captain uses.
    const env = await r.h.cmd("projects.setEnvironments", {
      project: "acme-api",
      environments: [{ env: "production", tier: "production", check: "https://orders.acme.example/health" }],
    });
    expect(env.status).toBe(200);
    const store = services.store;
    const before = store.deploys.create({
      org: "acme",
      project: "acme-api",
      env: "production",
      commit: PREVIOUS,
      state: "queued",
      runs: DEPLOY_RUNS,
      by: "owner",
      at: new Date().toISOString(),
    });
    for (const [from, to] of [
      ["queued", "running"],
      ["running", "verifying"],
      ["verifying", "live"],
    ] as const)
      store.deploys.move(before?.id ?? 0, from, to, new Date().toISOString());
    // The deploy service itself is covered by the deploy test: here it goes live at the head the fix landed as.
    const deployed: string[] = [];
    vi.spyOn(services.deploy.service, "deploy").mockImplementation(async (input, actor) => {
      if (!("project" in input)) throw new Error("A case deploy names its project");
      const base = store.tasks.get(input.task ?? "")?.repos[0]?.base ?? "main";
      const head = (await git(join(r.h.dir, "Work", "api"), "rev-parse", base)).trim();
      const at = new Date().toISOString();
      const made = store.deploys.create({
        org: "acme",
        project: input.project,
        env: input.env,
        commit: head,
        state: "queued",
        runs: input.runs,
        by: actor,
        ...(input.task === undefined ? {} : { task: input.task }),
        at,
      });
      const id = made?.id ?? 0;
      store.deploys.move(id, "queued", "running", at, { previous: PREVIOUS });
      store.deploys.move(id, "running", "verifying", at);
      const live = store.deploys.move(id, "verifying", "live", at);
      deployed.push(`${input.project} ${input.env} ${actor}`);
      fixed.value = true;
      if (live === undefined) throw new Error("The fake deploy did not go live");
      return { record: live, repeat: false };
    });

    const now = new Date();
    await say(r, "print slips are not generated and orders cannot be sent to the courier", "1", now);
    // The fake helper only sleeps for its job (a prompt line that starts with run: is a shell command to it). The fix
    // itself is committed below, in the helper's worktree, while it sleeps.
    const JOB = "run: sleep 2";
    await writeFile(
      join(r.lane.folder, "CAPTAIN_SCRIPT.json"),
      JSON.stringify({
        rules: [
          {
            when: "Client chat",
            flags: "",
            steps: [
              step("majhi_chat_openIncident", {
                room: r.room.id,
                found: "The courier status sweep fails on a missing carrier.",
              }),
              step("majhi_case_status", { now: "Reading the courier job on the host" }),
              ssh("docker logs --tail 50 acme-worker"),
              step("majhi_chat_reply", { room: r.room.id, text: REPLY_1, ...FLAGS }),
              step("majhi_case_help", { project: "acme-api", job: JOB }),
            ],
          },
        ],
      }),
    );
    const first = await wakeAndWait(r, 5);
    expect(first.every((d) => !d.isError)).toBe(true);
    const caseId = (await work(r))[0]?.id ?? "";
    const branch = services.cases.recordOf(caseId)?.helper?.branch ?? "";
    expect(branch).not.toBe("");

    // The helper's fix: a commit on its branch, in its own worktree of the project.
    const worktree = services.store.tasks.get(caseId)?.repos[0]?.worktree ?? "";
    await writeFile(join(worktree, "sweep-fix.txt"), "skip a missing carrier\n");
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-m", "fix(courier): skip a missing carrier");

    // The owner's Fix switch is the off switch: at Ask me the captain cannot deploy, whatever the level.
    await w?.h.cmd("authority.set", { org: "acme", fix: "ask" });
    await expect(services.cases.deploy(r.lane.id, { case: caseId, branch })).rejects.toThrow("Fix switch");
    expect(deployed).toEqual([]);
    await w?.h.cmd("authority.set", { org: "acme", fix: "ships" });

    // The helper reports back in the case; the captain deploys what it wrote, reads the symptom and closes.
    await writeFile(
      join(r.lane.folder, "CAPTAIN_SCRIPT.json"),
      JSON.stringify({
        rules: [
          {
            when: "reported back on case",
            flags: "",
            steps: [
              step("majhi_case_deploy", { branch }),
              ssh("curl -sf localhost:8000/slips/health"),
              step("majhi_case_close", {
                summary: [
                  "Slips and courier orders failed.",
                  "The courier status sweep failed on a missing carrier in the code.",
                  "A helper fixed it and the fix went out through the project's own deploy.",
                  "The slips check answers again.",
                ].join("\n"),
                tell: { text: REPLY_2, ...FLAGS },
              }),
            ],
          },
        ],
      }),
    );
    await w?.until(async () => (await lines(r)).length >= 8, "the captain's turn after the helper");
    await services.runs.idle(r.lane.id);
    const done = await lines(r);
    expect(done.slice(5).map((d) => [d.tool, d.isError])).toEqual([
      ["majhi_case_deploy", false],
      ["ssh", false],
      ["majhi_case_close", false],
    ]);

    // One case, closed. No second task, no card for the owner, two messages to the client.
    expect((await work(r)).map((t) => [t.typing?.type, t.status])).toEqual([["incident", "done"]]);
    expect((await owner(r)).decisions).toEqual([]);
    expect(r.sent).toHaveLength(2);
    // The fix landed through the helper's branch, was deployed once through the captain, and the summary says so.
    expect(deployed).toEqual(["acme-api production captain"]);
    const kase = services.cases.recordOf(caseId);
    expect(kase?.helper).toMatchObject({ agent: "acme-builder", project: "acme-api", branch });
    expect(kase?.deploys).toMatchObject([{ env: "production", previous: PREVIOUS, state: "live" }]);
    expect(kase?.summary?.split("\n").at(-1)).toBe(
      `Deployed ${branch} to acme-api production (replaced 1111111).`,
    );
  });
});

describe("the case replay when the project's deploy needs an answer", () => {
  it("refuses the deploy, asks the owner once with one card, deploys nothing, and keeps the case open", async () => {
    const r = await replayWorld(codeBugHost({ value: false }));
    const { services } = r;
    // The project deploys from its CI, and nothing says which version the environment runs now.
    const found = discoverEnvironments({
      files: await acmeShopCi(),
      base: "main",
      provider: "github",
      remote: "origin",
      folders: ["backend", "frontend"],
    });
    const acme = found.environments.find((e) => e.env === "acme");
    expect(
      (await r.h.cmd("projects.setEnvironments", { project: "acme-api", environments: [acme] })).status,
    ).toBe(200);
    const deploy = vi.spyOn(services.deploy.service, "deploy");

    await say(r, "print slips are not generated and orders cannot be sent to the courier", "1", new Date());
    await writeFile(
      join(r.lane.folder, "CAPTAIN_SCRIPT.json"),
      JSON.stringify({
        rules: [
          {
            when: "Client chat",
            flags: "",
            steps: [
              step("majhi_chat_openIncident", { room: r.room.id, found: "The courier sweep fails in code." }),
              step("majhi_case_help", { project: "acme-api", job: "run: sleep 2" }),
            ],
          },
        ],
      }),
    );
    await wakeAndWait(r, 2);
    const caseId = (await work(r))[0]?.id ?? "";
    const branch = services.cases.recordOf(caseId)?.helper?.branch ?? "";
    const worktree = services.store.tasks.get(caseId)?.repos[0]?.worktree ?? "";
    await writeFile(join(worktree, "sweep-fix.txt"), "skip a missing carrier\n");
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-m", "fix(courier): skip a missing carrier");
    await writeFile(
      join(r.lane.folder, "CAPTAIN_SCRIPT.json"),
      JSON.stringify({
        rules: [
          {
            when: "reported back on case",
            flags: "",
            // A second call is refused too, and writes no second card.
            steps: [step("majhi_case_deploy", { branch }), step("majhi_case_deploy", { branch })],
          },
        ],
      }),
    );
    await w?.until(async () => (await lines(r)).length >= 4, "the captain's turn after the helper");
    await services.runs.idle(r.lane.id);
    const done = (await lines(r)).slice(2);
    expect(done.map((d) => d.isError)).toEqual([true, true]);
    expect(done[0]?.text).toContain("previous-version");

    // One card (the build version and the version acme runs now), no deploy started, the case still open and nothing in the way of a task.
    const cards = (await owner(r)).decisions;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toContain("Which version should the build make");
    expect(deploy).not.toHaveBeenCalled();
    expect((await work(r)).map((t) => [t.typing?.type, t.status])).toEqual([["incident", "running"]]);
  });
});
