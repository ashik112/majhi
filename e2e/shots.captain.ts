import { expect, type Page, test } from "@playwright/test";
import type {
  Authority,
  AutonomyEvent,
  AutonomyStatus,
  CaptainAction,
  CaptainOrg,
  CaptainStatus,
  Finding,
  FindingSource,
  OwnerDecision,
  RoomItem,
  RoomServerMessage,
  Task,
} from "../packages/shared/src/index.ts";

/**
 * The Captain page (SPEC 5.18): one screen with the Autonomous switch, one status sentence, the
 * conversation on the left and the Now column on the right. Delegation, the log and the summary open
 * in sheets. The server is the seeded one (`ui`); the captain's status, Autonomous, the log, the
 * decisions and the threads are stubbed in the browser, at the volume of a real day: 4 workspaces,
 * 30 tasks shipped, 9 notes, 5 decisions, 120 log events, a turn with 40 tool calls, one workspace
 * over its budget. A second set has 6 workspaces, one with a very long name.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.captain.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/captain-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const DAY = "2026-10-04";
const LONG = "Northwind Traders International Holdings and Logistics Group";
const LONG_TASK =
  "Move every caller of the old synchronous export to the queued worker, with retries, progress events and a signed download link that expires after a day";

const FINDING_TITLES = [
  "Flaky test in the retry suite fails one run in five",
  "Update the http client: two advisories since last month",
  "Add a timeout test to the api client",
  "The staging credentials were never rotated",
  "Build time grew 40 percent since the lockfile change",
  "Empty state on the invoices page shows a raw error",
  "Move every caller of the old synchronous export to the queued worker, with retries and a signed download link",
  "Competitor launched a free tier for small teams",
] as const;
const FINDING_SOURCES: FindingSource[] = ["follow-up", "ci", "dependency", "security", "ui", "log", "radar"];

/** 140 findings over four workspaces: open, proposed, a task, dismissed and fixed. */
function findings(): Finding[] {
  const orgIds = ["private", "hooli", "initech", "umbrella"];
  const status = ["open", "open", "open", "proposed", "task", "dismissed", "fixed", "open"] as const;
  const severity = ["info", "low", "medium", "high"] as const;
  return Array.from({ length: 140 }, (_, i) => {
    const s = status[i % status.length] ?? "open";
    const title = FINDING_TITLES[i % FINDING_TITLES.length] ?? "Finding";
    return {
      id: i + 1,
      org: orgIds[i % orgIds.length] ?? "private",
      project: i % 3 === 0 ? "acme-api" : undefined,
      source: FINDING_SOURCES[i % FINDING_SOURCES.length] ?? "other",
      title: i < 8 ? title : `${title} (${i})`,
      detail: "The retry test in api/retry.test.ts fails one run in five.\nSeen in the last three CI runs.",
      evidence: ["ci run 4412", "api/retry.test.ts:31"],
      severity: severity[i % severity.length] ?? "info",
      dedupeKey: `k${i}`,
      status: s,
      task: s === "proposed" || s === "task" ? `PRV-${100 + i}` : undefined,
      dismissedReason: s === "dismissed" ? "Not worth doing: the suite is replaced next month" : undefined,
      by: "captain",
      seen: 1 + (i % 4),
      createdAt: iso(i < 6 ? 120 : 3000 + i * 40),
      updatedAt: iso(30 + i),
      lastSeen: iso(30 + i * 7),
    } as Finding;
  });
}

const CHORES = ["ship", "cards", "questions", "memory", "projects", "triage", "cleanup", "stuck"] as const;

const ROWS = (
  start: boolean,
  answers: boolean,
  upkeep: boolean,
  merge: boolean,
  push: boolean,
): Authority => ({
  start: start ? "decide" : "ask",
  questions: answers ? "decide" : "ask",
  approvals: answers ? "decide" : "ask",
  upkeep: upkeep ? "decide" : "ask",
  merge: merge ? "decide" : "ask",
  own: "ask",
  push: push ? "decide" : "ask",
});
const RUNS_ROWS = ROWS(true, true, true, false, false);
const TIDY_ROWS = ROWS(false, true, true, false, false);
const ASK_ROWS = ROWS(false, false, false, false, false);

type Mode = "on" | "off";
interface Scenario {
  /** `real`: 4 workspaces at the volume of a real day. `many`: 6 workspaces, one with a long name. */
  set: "real" | "many";
  mode: Mode;
}

function org(o: Partial<CaptainOrg> & Pick<CaptainOrg, "org" | "name" | "authority">): CaptainOrg {
  const asks = Object.values(o.authority).every((c) => c === "ask");
  return {
    thread: "idle",
    effective: o.authority,
    rules: { authority: o.authority },
    used: { tokens: 0, cost: 0 },
    summary: "",
    forYou: 0,
    chores: asks
      ? []
      : CHORES.map((chore) => ({ chore, today: 0, cap: chore === "ship" ? 5 : 1, lastRun: iso(20) })),
    ...o,
  };
}

function orgs(set: Scenario["set"]): CaptainOrg[] {
  const real = [
    org({
      org: "private",
      name: "Private",
      authority: RUNS_ROWS,
      budget: { cost: 100 },
      rules: { authority: RUNS_ROWS, cap: { cost: 100 } },
      used: { tokens: 8_120_000, cost: 31.04 },
      thread: "waiting",
      forYou: 2,
      lane: "LOCAL-31",
    }),
    org({
      org: "hooli",
      name: "Hooli",
      authority: ROWS(true, true, true, true, false),
      budget: { cost: 50 },
      rules: { authority: ROWS(true, true, true, true, false), cap: { cost: 50 } },
      used: { tokens: 19_000_000, cost: 80.56 },
      thread: "working",
      lane: "HOO-2",
      resting: "its budget of $50 for today is used up",
    }),
    org({
      org: "initech",
      name: "Initech",
      authority: TIDY_ROWS,
      used: { tokens: 6_000_000, cost: 29.1 },
      lane: "INI-9",
    }),
    org({
      org: "umbrella",
      name: "Umbrella",
      authority: ASK_ROWS,
      used: { tokens: 900_000, cost: 4.2 },
      lane: "UMB-4",
    }),
  ];
  if (set === "real") return real;
  return [
    ...real.slice(0, 3),
    org({ org: "acme", name: "Acme", authority: ROWS(true, true, true, true, true), budget: { cost: 8 } }),
    org({ org: "globex", name: "Globex", authority: TIDY_ROWS, used: { tokens: 3_000_000, cost: 8.9 } }),
    org({ org: "northwind", name: LONG, authority: ASK_ROWS, lane: "NW-3" }),
  ];
}

function captain(s: Scenario): CaptainStatus {
  return {
    stopped: false,
    autonomy: s.mode,
    captain: "setup",
    day: DAY,
    orgs: orgs(s.set),
  };
}

const ACTIONS: CaptainAction[] = [
  {
    id: 41,
    at: iso(12),
    org: "private",
    chore: "ship",
    text: "Shipped PRV-14 to main: Move the notes export to the queued worker",
    reason: "In Private the captain decides when work is merged",
    evidence: "committed, merges cleanly into main, no card waits, no secret in the diff",
    task: "PRV-14",
    outcome: "done",
    undo: "yes",
  },
  {
    id: 40,
    at: iso(30),
    org: "hooli",
    chore: "ship",
    text: "Asked you to ship HOO-505: Shop orders created twice",
    reason: "In Hooli you decide when work is pushed, so the captain asks before shipping",
    task: "HOO-505",
    outcome: "asked",
    undo: "no",
    undoNote: "A card for you: nothing to undo",
  },
  {
    id: 39,
    at: iso(44),
    org: "initech",
    chore: "cards",
    text: "Approved: Add the reviewer to INI-501",
    reason: "A change within the limits",
    evidence: "@initech-builder asked to run team.add",
    task: "INI-501",
    outcome: "done",
    undo: "yes",
  },
  {
    id: 38,
    at: iso(70),
    org: "private",
    chore: "memory",
    text: "Kept a memory: The notes service reads its config from NOTES_HOME, never from the cwd",
    reason: "Memories that wait are kept, merged or dropped once a day",
    outcome: "done",
    undo: "yes",
  },
  {
    id: 37,
    at: iso(95),
    org: "private",
    chore: "ship",
    text: "Shipped PRV-11 to main and pushed: Tidy the sync script",
    reason: "In Private the captain decides when work is merged and pushed",
    task: "PRV-11",
    outcome: "done",
    undo: "no",
    undoNote: "It was pushed, and a push cannot be undone",
  },
  {
    id: 35,
    at: iso(160),
    org: "private",
    chore: "triage",
    text: "Set PRV-9 to high priority: Renew the domain",
    reason: "It is due on 2026-10-04",
    task: "PRV-9",
    outcome: "done",
    undo: "done",
    undoneAt: iso(150),
  },
];

const TITLES: Record<string, string> = {
  "PRV-14": "Move the notes export to the queued worker",
  "HOO-505": "Shop orders created twice",
  "HOO-430": "Phase 7: Resilience",
  "HOO-432": "Resilience and health",
  "INI-501": "Add the reviewer to the Initech agents",
  "PRV-11": "Tidy the sync script",
  "PRV-9": "Renew the domain",
  "INI-88": "Add rate limits to the public search endpoint",
  "UMB-12": LONG_TASK,
};

function events(): AutonomyEvent[] {
  const out: AutonomyEvent[] = [
    {
      seq: 400,
      at: iso(3),
      kind: "task",
      org: "hooli",
      text: "HOO-430 paused (owner): Phase 7: Resilience",
      task: "HOO-430",
      status: "paused",
    },
    {
      seq: 399,
      at: iso(4),
      kind: "task",
      org: "private",
      text: "LOCAL-16 is running: Private",
      task: "LOCAL-16",
      status: "running",
    },
    {
      seq: 398,
      at: iso(6),
      kind: "task",
      org: "hooli",
      text: "HOO-2 is done: Hooli",
      task: "HOO-2",
      status: "done",
    },
    {
      seq: 397,
      at: iso(8),
      kind: "decision",
      org: "hooli",
      text: "Start a task HOO-432: Resilience and health",
      reason: "Top of the backlog",
      task: "HOO-432",
      outcome: "applied",
    },
    { seq: 396, at: iso(9), kind: "tick", text: "Woke the captain: HOO-429 is done" },
    {
      seq: 395,
      at: iso(14),
      kind: "approval",
      org: "initech",
      text: "Left for the owner: Push task/INI-88-rate-limits. Initech does not let the captain push",
      task: "INI-88",
      outcome: "left",
    },
    {
      seq: 394,
      at: iso(20),
      kind: "cap",
      org: "hooli",
      text: "Hooli used its $50 for today. 3 tasks wait",
      reason: "The workspace budget is used up",
    },
    { seq: 393, at: iso(25), kind: "mode", text: "Autonomous turned off" },
  ];
  for (let i = 0; i < 112; i++) {
    out.push({
      seq: 392 - i,
      at: iso(30 + i * 9),
      kind: i % 3 === 0 ? "decision" : i % 3 === 1 ? "approval" : "answer",
      org: ["private", "hooli", "initech", "umbrella"][i % 4] as string,
      text: `Answered a question in UMB-12: use the queued worker (${i})`,
      reason: "The brief settles it",
      task: "UMB-12",
      outcome: "applied",
    });
  }
  return out;
}

function autonomy(s: Scenario): AutonomyStatus {
  const lane = (o: string, name: string, extra: Partial<AutonomyStatus["lanes"][number]>) => ({
    org: o,
    name,
    working: false,
    spend: { used: { tokens: 0, cost: 0 }, percent: 0, reached: false },
    tasks: 0,
    backlog: 0,
    ...extra,
  });
  const shipped = Array.from({ length: 30 }, (_, i) => ({
    task: `HOO-${300 + i}`,
    title:
      i % 7 === 0
        ? LONG_TASK
        : `Ship the ${["export", "billing", "search", "notes", "sync"][i % 5]} change number ${i + 1}`,
    org: ["private", "hooli", "initech", "umbrella"][i % 4] as string,
    how: (["merged", "pushed", "mr-open", "review"] as const)[i % 4] as "merged",
  }));
  return {
    mode: s.mode,
    stopped: [],
    raised: {},
    since: iso(95),
    by: "owner",
    boss: {
      id: "setup",
      chat: "LOCAL-31",
      working: s.mode === "on",
      nowDoing: "Reading the Private backlog",
    },
    lanes: [
      lane("private", "Private", { chat: "LOCAL-31", working: true, tasks: 2, backlog: 5 }),
      lane("hooli", "Hooli", { chat: "HOO-2", tasks: 1, backlog: 3 }),
    ],
    now:
      s.mode === "off"
        ? []
        : [
            {
              task: "HOO-432",
              title: "Resilience and health",
              org: "hooli",
              status: "running",
              agents: [{ id: "hoo-builder", nowDoing: "Editing src/export/worker.ts and its tests" }],
              why: "Top of the backlog; the export times out for three customers",
            },
            {
              task: "UMB-12",
              title: LONG_TASK,
              org: "umbrella",
              status: "review",
              agents: [{ id: "idz-builder" }],
              why: "Small and blocks the Umbrella release",
            },
          ],
    queue:
      s.mode === "off"
        ? []
        : [
            {
              title: "Signed download links for finished exports",
              task: "INI-432",
              org: "initech",
              why: "Next child of the export work; it waits on nothing and the Initech account has 60% of its window left",
            },
            {
              title: "Document the export API for partners",
              task: "INI-437",
              org: "initech",
              why: "Low priority filler for when the builders are idle",
            },
            {
              title: "Tidy the README and the setup script",
              task: "PRV-91",
              org: "private",
              why: "Small, cheap model, can run while Private has room",
            },
          ],
    queuedAt: iso(4),
    backlog: [
      {
        task: "INI-432",
        title: "Signed download links for finished exports",
        org: "initech",
        status: "ready",
        priority: "high",
        size: "small",
        sizeNote: "Laya rated it small (0.81)",
        noAutonomy: false,
      },
      {
        task: "HOO-95",
        title: "Migrate the billing tables to the new schema",
        org: "hooli",
        status: "inbox",
        size: "large",
        sizeNote: "Laya rated it large (0.64)",
        noAutonomy: true,
        leftOut: "Marked as one to leave alone",
      },
    ],
    holds: [],
    spend: {
      day: DAY,
      tz: "Europe/Berlin",
      resetsAt: new Date(NOW + 6 * 3600_000).toISOString(),
      total: { used: { tokens: 34_000_000, cost: 144.9 }, cap: { cost: 200 }, percent: 72, reached: false },
      orgs: [],
    },
    accounts: [],
    waiting: [],
    settings: {
      day: { cost: 200 },
      orgs: { private: { cap: { cost: 100 } }, hooli: { cap: { cost: 50 } } },
      floors: { window: 10, weekly: 5 },
      summary_at: "08:00",
      tz: "Europe/Berlin",
      instructions: [
        {
          id: "abcd1234",
          text: "Be careful in the Hooli billing code; no product-specific fixes.",
          at: iso(3000),
        },
      ],
      pick: { size: "medium" },
    },
    summary: {
      day: "2026-10-03",
      from: iso(1500),
      to: iso(60),
      at: iso(55),
      shipped,
      shipGroups: ["private", "hooli", "initech", "umbrella"].map((org, n) => {
        const mine = shipped.filter((s) => s.org === org);
        return {
          org,
          name: ["Private", "Hooli", "Initech", "Umbrella"][n] as string,
          count: mine.length,
          titles: mine.slice(0, 3).map((s) => s.title),
        };
      }),
      spent: {
        total: { used: { tokens: 19_000_000, cost: 80.56 }, cap: { cost: 50 }, percent: 161, reached: true },
        orgs: [
          {
            org: "private",
            name: "Private",
            used: { tokens: 6_000_000, cost: 31.1 },
            cap: { cost: 100 },
            percent: 31,
            reached: false,
          },
          {
            org: "hooli",
            name: "Hooli",
            used: { tokens: 9_000_000, cost: 38.2 },
            cap: { cost: 30 },
            percent: 127,
            reached: true,
          },
          {
            org: "initech",
            name: "Initech",
            used: { tokens: 3_000_000, cost: 8.4 },
            percent: 0,
            reached: false,
          },
          {
            org: "umbrella",
            name: LONG,
            used: { tokens: 1_000_000, cost: 2.86 },
            cap: { cost: 20 },
            percent: 14,
            reached: false,
          },
        ],
      },
      unsure: Array.from({ length: 9 }, (_, i) => ({
        text:
          i === 1
            ? `Skipped HOO-${50 + i}: the certificates need the owner's VPN and a second signing key that only the owner holds`
            : `Skipped HOO-${50 + i}: the certificates need the owner's VPN`,
        task: `HOO-${50 + i}`,
      })),
      waiting: [],
      needs: {
        count: 5,
        top: [
          {
            id: "room:PRV-14:1",
            title: "Ready to ship. Move the notes export to the queued worker",
            org: "private",
          },
          { id: "room:HOO-310:1", title: `Ready to ship. ${LONG_TASK}`, org: "hooli" },
          { id: "room:INI-432:1", title: "Approve running the migration in Initech", org: "initech" },
        ],
      },
      next: [
        {
          title: "Signed download links for finished exports",
          task: "INI-432",
          org: "initech",
          why: "Next child of the export work and it waits on nothing",
        },
        {
          title: "Document the export API for partners",
          task: "INI-437",
          org: "initech",
          why: "Low priority filler for when the builders are idle",
        },
        {
          title: "Tidy the README and the setup script",
          task: "PRV-91",
          org: "private",
          why: "Small, cheap model",
        },
      ],
      upkeep: 14,
      decisions: 23,
    },
    lastTick: iso(4),
  };
}

function decisions(): OwnerDecision[] {
  const ship = (id: string, task: string, org: string, title: string, why: string): OwnerDecision => ({
    id: `room:${task}:1`,
    kind: "ship",
    org,
    task,
    taskTitle: title,
    title: `Ready to ship. ${title}`,
    options: [
      { id: "merge", label: "Merge", primary: true },
      { id: "mergePush", label: "Merge and push" },
    ],
    suggestion: { option: "merge", reason: why, by: "captain" },
    at: iso(40),
    link: { kind: "task", id: task },
  });
  const review = (task: string, org: string, title: string): OwnerDecision => ({
    id: `room:${task}:2`,
    kind: "approval",
    org,
    task,
    taskTitle: title,
    title: `${title} is ready for review`,
    options: [],
    at: iso(90),
    link: { kind: "task", id: task },
  });
  return [
    ship("a", "HOO-505", "hooli", "Shop orders created twice", "Checks pass and the diff is small"),
    ship("b", "PRV-14", "private", "Move the notes export to the queued worker", "Merges cleanly into main"),
    review("INI-88", "initech", "Add rate limits to the public search endpoint"),
    review("UMB-12", "umbrella", LONG_TASK),
    review("HOO-430", "hooli", "Phase 7: Resilience"),
  ];
}

const thread: Task = {
  id: "LOCAL-31",
  title: "Private",
  brief: "Captain lane",
  kind: "chat",
  status: "running",
  folder: "/Users/owner/.majhi/tasks/LOCAL-31",
  repos: [],
  team: ["setup"],
  mode: "lead",
  overrides: {},
  links: [],
  attachments: [],
  createdAt: iso(5000),
  updatedAt: iso(1),
};

/** A long chat: messages, with a turn of 40 tool calls and approvals in the middle. */
function conversation(chat: string): RoomItem[] {
  const out: RoomItem[] = [];
  let seq = 1;
  const base = (id: string, minutesAgo: number) => ({ id, task: chat, seq: seq++, at: iso(minutesAgo) });
  out.push({
    ...base("o1", 120),
    type: "owner",
    text: "Why only small tasks yesterday? Take the export rework too.",
    attachments: [],
    queued: false,
  } as RoomItem);
  for (let n = 0; n < 40; n++) {
    out.push({
      ...base(`t${n}`, 110 - n),
      type: "tool",
      agent: "setup",
      toolCallId: `call${n}`,
      title:
        n % 3 === 0
          ? "Read apps/server/src/export/worker.ts"
          : n % 3 === 1
            ? "grep -rn queueExport"
            : "cd /Users/owner/Work/shop && git log",
      kind: n % 3 === 0 ? "read" : n % 3 === 1 ? "search" : "execute",
      status: "completed",
      locations: [],
      content: [],
    } as RoomItem);
    if (n % 5 === 0)
      out.push({
        ...base(`p${n}`, 110 - n),
        type: "permission",
        agent: "setup",
        title: "cd /Users/owner/Work/shop && git log",
        options: [],
        state: "auto",
        chosen: "Allowed by rule",
      } as RoomItem);
  }
  out.push({
    ...base("a1", 60),
    type: "agent",
    agent: "setup",
    text: "Yesterday the export rework was rated large, so I left it. **HOO-432** is running now, and the export rework comes after it. Two ship questions wait for you in Decisions.",
  } as RoomItem);
  out.push({
    ...base("o2", 40),
    type: "owner",
    text: "Fine. Keep Hooli under its budget today.",
    attachments: [],
    queued: false,
  } as RoomItem);
  out.push({
    ...base("a2", 38),
    type: "agent",
    agent: "setup",
    text: "Hooli is over its $50 for today, so I stopped starting work there. I will pick it up tomorrow.",
  } as RoomItem);
  return out;
}

const chat = (id: string, title: string, agent: string, minutesAgo: number, org?: string) => ({
  id,
  title,
  kind: "chat",
  status: "running",
  team: [agent],
  mode: "lead",
  updatedAt: iso(minutesAgo),
  repos: [],
  working: [],
  links: [],
  waitingOn: [],
  chat: true,
  ...(org === undefined ? {} : { org }),
});
const taskRow = (id: string, title: string, org?: string) => ({
  id,
  title,
  kind: "code",
  status: "running",
  team: ["setup"],
  mode: "lead",
  updatedAt: iso(30),
  repos: [],
  working: [],
  links: [],
  waitingOn: [],
  ...(org === undefined ? {} : { org }),
});
const CHATS = [
  chat("LOCAL-12", "Chat", "setup", 3),
  chat("LOCAL-16", "Private", "setup", 4),
  chat("HOO-2", "Hooli", "setup", 6, "hooli"),
];

async function stub(page: Page, s: Scenario, state: { decisions: OwnerDecision[] }) {
  const answer = (name: string, json: () => unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => r.fulfill({ json: json() }));
  await answer("captain.status", () => captain(s));
  await answer("captain.log", () => ({ actions: ACTIONS, runs: [] }));
  await answer("captain.asks", () => ({ asks: [], budgets: [] }));
  await answer("autonomy.status", () => autonomy(s));
  await answer("autonomy.events", () => ({ events: events().slice(0, 50) }));
  await answer("findings.list", () => {
    const all = findings();
    const open = all.filter((f) => f.status === "open");
    return {
      findings: all,
      open: open.length,
      fresh: open.filter((f) => Date.parse(f.createdAt) > NOW - 86_400_000).length,
    };
  });
  await answer("decisions.list", () => ({ decisions: state.decisions }));
  await answer("tasks.list", () => [
    ...CHATS,
    ...Object.entries(TITLES).map(([id, title]) => taskRow(id, title)),
  ]);
  await answer("boss.chat", () => ({ ...thread, id: "LOCAL-40", title: "Captain chat", team: ["setup"] }));
  await answer("tasks.get", () => thread);
  await answer("room.items", () => ({ items: conversation("LOCAL-31").reverse(), more: false }));
  await page.route("**/api/cmd/decisions.answer", async (r) => {
    const id = (r.request().postDataJSON() as { id?: string } | null)?.id;
    state.decisions = state.decisions.filter((d) => d.id !== id);
    await r.fulfill({ json: { decisions: state.decisions } });
  });
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => {
    const snapshot = {
      type: "snapshot",
      more: false,
      processes: [],
      agents: [{ agent: "setup", status: "idle", queued: 0, commands: [] }],
      items: conversation("LOCAL-31"),
    } as unknown as RoomServerMessage;
    ws.send(JSON.stringify(snapshot));
  });
}

async function open(page: Page, path: string, w: number, h: number, theme: string, s: Scenario) {
  await page.setViewportSize({ width: w, height: h });
  await stub(page, s, { decisions: decisions() });
  await page.goto(path);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(900);
}

async function noPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

const REAL_ON: Scenario = { set: "real", mode: "on" };
const REAL_OFF: Scenario = { set: "real", mode: "off" };
const MANY_ON: Scenario = { set: "many", mode: "on" };

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`on ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await expect(page.getByRole("region", { name: "Needs you" })).toBeVisible();
      await expect(page.getByText("On: 2 running, 3 next. 5 decisions wait for you.")).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/on-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`off ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_OFF);
      await expect(
        page.getByText(/^Off: it only answers when you ask, and keeps memory and cleanup going\./),
      ).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/off-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`many workspaces ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, MANY_ON);
      await page.getByRole("button", { name: LONG }).first().click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/many-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`workspace thread ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await page
        .getByRole("button", { name: /^Private/ })
        .first()
        .click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/thread-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`delegation ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await page.getByRole("button", { name: "Delegation" }).click();
      await expect(page.getByRole("dialog", { name: "Delegation" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/delegation-${w}-${theme}.png` });
    });
    test(`delegation with six workspaces ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain?tab=rules", w, h, theme, MANY_ON);
      await expect(page.getByRole("dialog", { name: "Delegation" })).toBeVisible();
      await page.getByRole("button", { name: /^Standing instructions/ }).click();
      await page.getByRole("button", { name: /^Leave alone/ }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/delegation-many-${w}-${theme}.png` });
    });
    test(`log sheet ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await page.getByRole("button", { name: "See all" }).click();
      await expect(page.getByRole("dialog", { name: "Log" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/log-${w}-${theme}.png` });
    });
    test(`findings box and sheet ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      const box = page.getByRole("region", { name: "Findings" });
      await expect(box).toBeVisible();
      await box.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/findings-box-${w}-${theme}.png` });
      await box.getByRole("button", { name: "All findings" }).click();
      await expect(page.getByRole("dialog", { name: "Findings" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/findings-${w}-${theme}.png` });
      // Keys: move down, open the detail, start a dismissal.
      await page.getByRole("listbox", { name: "Findings" }).focus();
      await page.keyboard.press("j");
      await page.keyboard.press("Enter");
      await page.keyboard.press("d");
      await expect(page.getByLabel("Why dismiss this finding")).toBeFocused();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/findings-dismiss-${w}-${theme}.png` });
    });
    test(`summary sheet ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await page.getByRole("button", { name: /^Yesterday: shipped 30/ }).click();
      await expect(page.getByRole("dialog", { name: "Daily summary" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/summary-${w}-${theme}.png` });
    });
  }
}

test("the header says what is true, and the summary is one line", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  await expect(
    page.getByRole("button", { name: /^Yesterday: shipped 30, spent \$80\.56 of \$50 \(over\), 9 notes/ }),
  ).toBeVisible();
  await expect(page.locator("#main").getByRole("switch", { name: "Autonomous" })).toBeChecked();
  const header = page.locator("header").first();
  await expect(header.getByText("Hooli")).toBeVisible();
});

test("the summary sheet is short: groups, three of each list, notes expand, the time changes there", async ({
  page,
}) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  await page.getByRole("button", { name: /^Yesterday: shipped 30/ }).click();
  const sheet = page.getByRole("dialog", { name: "Daily summary" });
  await expect(sheet.getByRole("region", { name: "Shipped" }).locator("p")).toHaveCount(5);
  await expect(
    sheet.getByRole("region", { name: "Needs you" }).getByRole("link", { name: "All 5 in Decisions" }),
  ).toBeVisible();
  await expect(sheet.getByRole("region", { name: "Next" }).locator("p")).toHaveCount(3);
  await expect(sheet.getByText("(over)")).toHaveCount(2);
  const notes = sheet.getByRole("region", { name: "Notes" });
  await expect(notes.locator("p")).toHaveCount(3);
  await notes.getByRole("button", { name: "+6 more" }).click();
  await expect(notes.locator("p")).toHaveCount(9);
  await expect(sheet.getByLabel("Made every day at")).toHaveValue("08:00");
});

test("Needs you shows two whole rows and links to the rest, answered inline", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  const box = page.getByRole("region", { name: "Needs you" });
  await expect(box.locator("[data-decision]")).toHaveCount(2);
  await expect(box.getByRole("link", { name: "All 5 in Decisions" })).toBeVisible();
  await box.locator("[data-decision]").first().getByRole("button", { name: "Merge", exact: true }).click();
  await expect(box.locator("[data-decision]")).toHaveCount(2);
  await expect(page.getByText("4 decisions wait for you.")).toBeVisible();
});

test("the turn with 40 tool calls folds into one line", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  const steps = page.getByRole("button", { name: /steps it took/ });
  await expect(steps).toHaveCount(1);
  await expect(steps).toHaveText(/40 steps it took/);
  await expect(page.getByText("Allowed by rule")).toHaveCount(0);
  await steps.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/steps-open-1440-dark.png` });
});

test("the log has no ids and no old wording", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  const recent = page.getByRole("region", { name: "Did recently" });
  await expect(
    recent.getByText("Shipped 'Move the notes export to the queued worker' to main"),
  ).toBeVisible();
  await expect(recent.getByText("Paused 'Phase 7: Resilience'")).toBeVisible();
  await expect(recent.getByText("Started 'Resilience and health'")).toBeVisible();
  await expect(recent.getByText("Asked you to ship 'Shop orders created twice'")).toBeVisible();
  await expect(recent.getByText(/LOCAL-16|Decision: applied|\(owner\)/)).toHaveCount(0);
});

test("old ways in still land on the same screen", async ({ page }) => {
  await open(page, "/autonomous", 1440, 900, "dark", REAL_ON);
  await expect(page).toHaveURL(/\/captain$/);
  await page.goto("/autonomous?tab=rules");
  await expect(page).toHaveURL(/\/captain\?tab=rules$/);
  await expect(page.getByRole("dialog", { name: "Delegation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/captain$/);
  await page.goto("/captain?tab=log");
  await expect(page.getByRole("dialog", { name: "Log" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/captain?tab=chat");
  await expect(page.getByRole("region", { name: "Conversation" })).toBeVisible();
});

test("the sidebar row and Cmd J open the conversation", async ({ page }) => {
  await open(page, "/", 1440, 900, "dark", REAL_ON);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("switch", { name: "Autonomous" })).toBeVisible();
  await nav.getByRole("link", { name: "Captain", exact: true }).click();
  await expect(page).toHaveURL(/\/captain$/);
  await page.goto("/chats");
  await page.waitForTimeout(900);
  await page.keyboard.press("ControlOrMeta+j");
  const drawer = page.getByRole("complementary", { name: "Captain" });
  await expect(drawer.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /^Private/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/drawer-1440-dark.png` });
});

test("the delegation grid toggles a cell and takes a budget", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  await page.route("**/api/cmd/autonomy.configure", (r) => r.fulfill({ json: autonomy(REAL_ON) }));
  await page.getByRole("button", { name: "Delegation" }).click();
  const sheet = page.getByRole("dialog", { name: "Delegation" });
  const posted = page.waitForRequest("**/api/cmd/autonomy.configure");
  await sheet.getByRole("button", { name: /^Push in Private/ }).click();
  expect((await posted).postDataJSON()).toMatchObject({
    orgs: { private: { authority: { push: "decide" } } },
  });
  const budget = sheet.getByRole("textbox", { name: "Daily budget of Initech in dollars" });
  await expect(budget).toHaveAttribute("placeholder", "shared");
  const saved = page.waitForRequest("**/api/cmd/autonomy.configure");
  await budget.fill("25");
  await budget.blur();
  expect((await saved).postDataJSON()).toMatchObject({ orgs: { initech: { cap: { cost: 25 } } } });
});

test("the Now column scrolls as one panel down to Did recently", async ({ page }) => {
  for (const [w, h] of [
    [1100, 760],
    [1280, 720],
  ] as const) {
    await open(page, "/captain", w, h, "dark", REAL_ON);
    const panel = page.getByLabel("Now", { exact: true });
    const recent = page.getByRole("region", { name: "Did recently" });
    await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(recent.locator("li").last()).toBeInViewport();
    await recent.getByRole("heading", { name: "Did recently" }).scrollIntoViewIfNeeded();
    await expect(recent.getByRole("heading", { name: "Did recently" })).toBeInViewport();
    await page.screenshot({ path: `${SHOTS}/now-scrolled-${w}-dark.png` });
    await noPageScroll(page);
  }
});

// One count, one name, no global strip, an update row that never hides the navigation ------------------
//
// The board has more tasks that wait than the inbox has decisions, the update notice is showing, and the
// summary is either yesterday's (fresh) or two days old (stale). Screenshots go to COHESION_SHOTS.

const COHESION = process.env.COHESION_SHOTS ?? `${SHOTS}/cohesion`;
const UPDATE = {
  running: "aaaaaaa1111111",
  onDisk: "bbbbbbb2222222",
  canUpdate: true,
  dirty: false,
  updateReady: true,
  changes: [
    "feat(health): checks with fixes",
    "fix(shell): banner spacing",
    "feat(decisions): one name per kind",
    "fix(captain): the summary chip only shows for the last two days",
  ],
};

/** 14 tasks that stopped (in review or paused) next to the usual rows, so the Waiting column is long. */
function boardRows() {
  const waiting = Array.from({ length: 14 }, (_, i) => ({
    ...taskRow(`INI-${100 + i}`, `Task number ${i + 1} that stopped and waits to be picked up`, "initech"),
    status: i % 3 === 0 ? "paused" : "review",
    ...(i % 3 === 0 ? { pausedReason: "limit" } : {}),
  }));
  return [...CHATS, ...Object.entries(TITLES).map(([id, title]) => taskRow(id, title)), ...waiting];
}

async function openCohesion(
  page: Page,
  path: string,
  w: number,
  h: number,
  theme: string,
  summary: "fresh" | "stale" = "fresh",
) {
  await page.setViewportSize({ width: w, height: h });
  await stub(page, REAL_ON, { decisions: decisions() });
  await page.route("**/api/cmd/tasks.list", (r) => r.fulfill({ json: boardRows() }));
  await page.route("**/api/cmd/system.version", (r) => r.fulfill({ json: UPDATE }));
  if (summary === "stale") {
    const status = autonomy(REAL_ON);
    await page.route("**/api/cmd/autonomy.status", (r) =>
      r.fulfill({
        json: { ...status, summary: status.summary && { ...status.summary, day: "2026-10-02" } },
      }),
    );
  }
  await page.goto(path);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(900);
}

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
  [900, 700],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`cohesion shots ${w} ${theme}`, async ({ page }) => {
      await openCohesion(page, "/", w, h, theme);
      await page.screenshot({ path: `${COHESION}/board-${w}-${theme}.png` });
      await page
        .locator("aside[aria-label=Sidebar]")
        .screenshot({ path: `${COHESION}/sidebar-${w}-${theme}.png` });
      await openCohesion(page, "/captain", w, h, theme);
      await page.screenshot({ path: `${COHESION}/captain-${w}-${theme}.png` });
      await openCohesion(page, "/captain", w, h, theme, "stale");
      await page.screenshot({ path: `${COHESION}/captain-stale-${w}-${theme}.png` });
      await openCohesion(page, "/decisions", w, h, theme);
      await page.screenshot({ path: `${COHESION}/decisions-${w}-${theme}.png` });
    });
  }
}

test("cohesion rules: every screen counts the same decisions", async ({ page }) => {
  await openCohesion(page, "/", 1440, 900, "dark");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: /^Decisions/ })).toContainText("5");
  await expect(page.getByRole("link", { name: /5 need you/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decisions, 5 need you" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting" })).toBeVisible();
  await page.goto("/captain");
  await expect(page.getByText("5 decisions wait for you.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Needs you" })).toContainText("5");
  await page.goto("/decisions");
  await expect(page.getByText("5 waiting for you")).toBeVisible();
});

test("cohesion rules: a kind has one name in the chips and the rows", async ({ page }) => {
  await openCohesion(page, "/decisions", 1440, 900, "dark");
  await expect(page.getByRole("button", { name: /^Ship \d/ })).toBeVisible();
  for (const retired of [/Ready for review/, /Daily limit/, /^Approvals/]) {
    await expect(page.getByText(retired)).toHaveCount(0);
  }
});

test("cohesion rules: no strip on any page, a dot on Captain, a chip only for the last two days", async ({
  page,
}) => {
  await openCohesion(page, "/", 1440, 900, "dark");
  await expect(page.getByRole("region", { name: "Autonomous" })).toHaveCount(0);
  const row = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Captain", exact: true });
  await expect(row).toHaveAccessibleDescription("A new daily summary is ready");
  await row.click();
  const chip = page.getByRole("button", { name: /^Yesterday: shipped 30/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveAccessibleDescription("A new daily summary is ready");
  await expect(chip).toHaveCount(0);

  await openCohesion(page, "/captain", 1440, 900, "dark", "stale");
  await expect(page.getByRole("button", { name: /shipped 30/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Summary" })).toBeVisible();
});

test("cohesion rules: the update row never hides a navigation row", async ({ page }) => {
  await openCohesion(page, "/", 1440, 900, "dark");
  const region = page.getByRole("region", { name: "Update ready" });
  await expect(region).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const name of [/Hub setup/, /Health and usage/, /Audit log/]) {
    await expect(nav.getByRole("link", { name })).toBeInViewport();
  }
  for (const [w, h] of [
    [1100, 760],
    [900, 700],
  ] as const) {
    await openCohesion(page, "/", w, h, "dark");
    await expect(region).toBeInViewport();
    for (const name of [/Hub setup/, /Health and usage/, /Audit log/]) {
      const link = nav.getByRole("link", { name });
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport();
    }
  }
  await region.getByRole("button", { name: /Update ready/ }).click();
  await expect(region.getByRole("list", { name: "Changes" })).toContainText("feat(health)");
  await page.screenshot({ path: `${COHESION}/update-open-900-dark.png` });
});
