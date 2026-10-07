import { type AutonomyHold, AutonomySettingsSchema, type CommandName } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { adminTools } from "../admin/tools.ts";
import { RUNS } from "../captain/authority-fixtures.ts";
import { hardLimit, type LimitWorld } from "./limits.ts";
import { type AutonomyCall, decideAutonomously, type PolicyContext, startsWork } from "./policy.ts";

const settings = AutonomySettingsSchema.parse({
  orgs: {
    acme: { authority: { ...RUNS, push: "decide" } },
    globex: { authority: { ...RUNS, merge: "decide" } },
  },
});

function call(command: CommandName, input: Record<string, unknown> = {}, extra: Partial<AutonomyCall> = {}) {
  return { command, input, org: "acme", confirm: false, ...extra };
}

function ctx(extra: Partial<PolicyContext> = {}): PolicyContext {
  return { settings, holds: [], accounts: [], ...extra };
}

const decide = (c: AutonomyCall, x: PolicyContext = ctx()) => decideAutonomously(c, x).decision;

describe("decideAutonomously: the table", () => {
  it("approves a change not listed, and leaves what only the owner decides", () => {
    expect(decide(call("tasks.create", { text: "write notes", start: false }))).toBe("approved");
    expect(decide(call("agents.create", { id: "acme-docs" }))).toBe("approved");
    expect(decide(call("schedules.create", {}))).toBe("approved");
    // Destructive, or a remove/delete/forget verb.
    expect(decideAutonomously(call("tasks.remove", { id: "ACM-1" }), ctx())).toEqual({
      decision: "left",
      why: "Only the owner removes things",
    });
    expect(decide(call("team.remove", { task: "ACM-1", agent: "acme-builder" }))).toBe("approved");
    expect(decide(call("memory.forget", { id: "f1" }))).toBe("left");
    // Where agents reach, and the owner's settings.
    for (const command of [
      "projects.register",
      "projects.update",
      "workspaces.set",
      "orgs.removeGitAccount",
      "tasks.changeBranch",
    ] as const) {
      expect([command, decide(call(command))]).toEqual([command, "left"]);
    }
    for (const command of [
      "settings.set",
      "boss.set",
      "history.undo",
      "decisions.set",
      "system.update",
      "cleanup.run",
      "usage.setPrice",
      "containers.images.allow",
      "decisions.install",
    ] as const) {
      expect([command, decide(call(command))]).toEqual([command, "left"]);
    }
    // The owner's answers: the captain answers with its own tool.
    expect(decide(call("room.answerAsk", {}))).toBe("left");
  });

  it("follows each org's push and merge setting", () => {
    // Acme may push, not merge. Globex may merge, not push.
    expect(decide(call("tasks.push", { id: "ACM-1" }))).toBe("approved");
    expect(decide(call("tasks.openMrs", { id: "ACM-1" }))).toBe("approved");
    expect(decide(call("tasks.push", { id: "GLX-1" }, { org: "globex" }))).toBe("left");
    expect(decide(call("tasks.merge", { id: "ACM-1" }))).toBe("left");
    expect(decide(call("tasks.merge", { id: "GLX-1" }, { org: "globex" }))).toBe("approved");
    // Merging the merge requests of a task follows the same Merge row.
    expect(decide(call("tasks.mergeMrs", { id: "GLX-1" }, { org: "globex" }))).toBe("approved");
    expect(decide(call("tasks.markMerged", { id: "ACM-1" }))).toBe("left");
    // An org with no entry may do neither.
    expect(decide(call("tasks.push", { id: "NW-1" }, { org: "northwind" }))).toBe("left");
    // Any other outbound call waits for the owner.
    expect(decide(call("tasks.resolveShip", { id: "ACM-1" }))).toBe("left");
    expect(decide(call("room.cardAction", {}))).toBe("left");
  });

  it("leaves work a cap or a floor holds, with the hold's line", () => {
    const day: AutonomyHold = { kind: "day-cap", text: "Autonomous reached its $20.00 cap for today" };
    const acme: AutonomyHold = { kind: "org-cap", id: "acme", text: "Acme reached its $5.00 cap for today" };
    const account: AutonomyHold = {
      kind: "account",
      id: "claude-acme",
      text: "claude-acme has 4% of its 5-hour window left",
    };
    expect(decideAutonomously(call("tasks.start", { id: "ACM-1" }), ctx({ holds: [day] }))).toEqual({
      decision: "left",
      why: day.text,
    });
    expect(decide(call("tasks.create", { text: "x", start: true }), ctx({ holds: [acme] }))).toBe("left");
    expect(
      decide(call("tasks.create", { text: "x", start: true }, { org: "globex" }), ctx({ holds: [acme] })),
    ).toBe("approved");
    expect(
      decide(
        call("team.add", { task: "ACM-1", agent: "acme-builder" }),
        ctx({ holds: [account], accounts: ["claude-acme"] }),
      ),
    ).toBe("left");
    expect(
      decide(
        call("tasks.split", { task: "ACM-1", start: true }),
        ctx({ holds: [account], accounts: ["claude-globex"] }),
      ),
    ).toBe("approved");
    // Creating without starting is no work yet.
    expect(decide(call("tasks.create", { text: "x", start: false }), ctx({ holds: [day] }))).toBe("approved");
    expect(startsWork("tasks.addAgent", {})).toBe(true);
    expect(startsWork("tasks.split", { start: false })).toBe(false);
  });

  it("leaves automations that start tasks or run commands, and every resume and run now, for the owner", () => {
    const start = { kind: "task.start", project: "acme-api", text: "nightly" };
    const run = { kind: "process.run", task: "ACM-1", command: "make test" };
    const post = { kind: "room.post", task: "ACM-1", text: "Check the build" };
    expect(decide(call("schedules.create", { name: "nightly", action: start }))).toBe("left");
    expect(decide(call("triggers.create", { name: "on red", action: run }))).toBe("left");
    expect(decide(call("schedules.create", { name: "nudge", action: post }))).toBe("approved");
    // An update that keeps the action is judged by the action it has now.
    expect(
      decide(call("schedules.update", { id: "s1", name: "x" }), ctx({ automationAction: "task.start" })),
    ).toBe("left");
    expect(
      decide(call("triggers.update", { id: "t1", name: "x" }), ctx({ automationAction: "room.post" })),
    ).toBe("approved");
    expect(
      decide(call("schedules.update", { id: "s1", action: post }), ctx({ automationAction: "task.start" })),
    ).toBe("approved");
    for (const command of [
      "schedules.resume",
      "schedules.runNow",
      "triggers.resume",
      "triggers.runNow",
    ] as const) {
      expect([command, decide(call(command, { id: "x" }))]).toEqual([command, "left"]);
    }
    expect(decide(call("schedules.pause", { id: "s1" }))).toBe("approved");
  });

  it("refuses first when a hard limit breaks, and leaves a fix task's start for the owner", () => {
    expect(decideAutonomously(call("tasks.create", { text: "x" }), ctx({ refused: "Refused: no" }))).toEqual({
      decision: "refused",
      why: "Refused: no",
    });
    expect(decide(call("tasks.start", { id: "ACM-2" }, { confirm: true }))).toBe("left");
  });
});

// ---------------------------------------------------------------------------

function world(org = "acme"): LimitWorld {
  return {
    org,
    orgs: {
      private: {},
      acme: {
        mr_tokens: { gitlab: "secret:acme-gitlab" },
        git_accounts: [
          { host: "gitlab.com", account: "acme-dev", ssh: "gitlab-acme", token: "secret:acme-dev-token" },
        ],
        connections: { "acme-k8s": { type: "kubectl", name: "Acme cluster", fields: { context: "prod" } } },
      },
      globex: {
        git_accounts: [{ host: "github.com", account: "globex-bot" }],
        connections: {
          "globex-db": {
            type: "env",
            name: "Globex DB",
            vars: { DB_PASSWORD: { kind: "secret", value: "secret:globex-db" } },
          },
        },
      },
    },
    accounts: {
      "claude-acme": { org: "acme" },
      "claude-globex": { org: "globex" },
      "api-private": { org: "private", key: "secret:anthropic-private" },
    },
    agents: {
      "acme-builder": { scope: "acme", account: "claude-acme", where: ["anywhere"], connections: [] },
      "acme-roamer": { scope: "acme", account: "claude-acme", where: ["acme", "globex"], connections: [] },
      boss: { scope: "root", account: "api-private", where: ["anywhere"], connections: ["globex-db"] },
      "globex-root": { scope: "root", account: "claude-globex", where: ["globex"], connections: [] },
      "globex-loose": { scope: "root", account: "claude-globex", where: ["anywhere"], connections: [] },
    },
    logins: [
      { host: "github.com", via: "gh", account: "globex-bot" },
      { host: "gitlab.com", via: "glab", account: "acme-dev" },
    ],
  };
}

const limit = (command: string, input: Record<string, unknown>, w: LimitWorld = world(), reason?: string) =>
  hardLimit({ command, input, ...(reason === undefined ? {} : { reason }) }, w);

describe("hardLimit", () => {
  it("never lets one org use a secret another org's config or accounts reference", () => {
    expect(limit("tasks.create", { text: "deploy with secret:globex-db" })).toContain("belongs to globex");
    expect(
      limit("connections.setSecret", { id: "acme-k8s", field: "token", ref: "secret:globex-db" }),
    ).toContain("belongs to globex");
    expect(
      limit(
        "connections.setSecret",
        { id: "globex-db", field: "x", ref: "secret:globex-db" },
        world("globex"),
      ),
    ).toBe(undefined);
    // `private` is an org: its account's key is not Acme's to use.
    expect(limit("tasks.create", { text: "use secret:anthropic-private" })).toContain("belongs to private");
    expect(limit("tasks.create", { text: "use secret:acme-gitlab" })).toBe(undefined);
  });

  it("takes only tokens an org already has for its MR tokens and git accounts", () => {
    expect(limit("orgs.update", { id: "acme", mr_tokens: { gitlab: "secret:acme-gitlab" } })).toBe(undefined);
    expect(limit("orgs.update", { id: "acme", mr_tokens: { gitlab: "secret:fresh-token" } })).toContain(
      "not a token acme already has",
    );
    expect(
      limit("orgs.update", {
        id: "acme",
        git_accounts: [{ host: "gitlab.com", account: "acme-dev", token: "secret:acme-dev-token" }],
      }),
    ).toBe(undefined);
    expect(limit("orgs.update", { id: "acme", mr_tokens: { github: "secret:globex-db" } })).toContain(
      "belongs to globex",
    );
  });

  it("keeps an org agent to its own org's account, where and connections", () => {
    const agent = (frontmatter: Record<string, unknown>) =>
      limit("agents.create", {
        id: "acme-new",
        frontmatter: { scope: "acme", role: "Builder", ...frontmatter },
      });
    expect(agent({ account: "claude-globex" })).toContain("belongs to globex");
    expect(agent({ account: "claude-acme" })).toBe(undefined);
    expect(agent({ account: "claude-acme", where: ["globex"] })).toContain("works only in acme");
    expect(agent({ account: "claude-acme", where: ["anywhere"] })).toContain("not in anywhere");
    expect(agent({ account: "claude-acme", where: ["acme"] })).toBe(undefined);
    expect(agent({ account: "claude-acme", connections: ["globex-db"] })).toContain("belongs to globex");
    expect(agent({ account: "claude-acme", connections: ["acme-k8s"] })).toBe(undefined);
    expect(limit("agents.edit", { id: "acme-builder", set: { account: "claude-globex" } })).toContain(
      "belongs to globex",
    );
    expect(limit("agents.edit", { id: "acme-builder", set: { where: ["globex"] } })).toContain(
      "works only in acme",
    );
    // A copy keeps its source's org: the default `anywhere` stays in its org, another org does not.
    expect(limit("agents.duplicate", { id: "acme-builder", newId: "acme-two" })).toBe(undefined);
    expect(limit("agents.duplicate", { id: "acme-roamer", newId: "acme-three" })).toContain("not in globex");
  });

  it("keeps a root agent on an org's account to that org, and lets one on a private account roam", () => {
    const root = (frontmatter: Record<string, unknown>) =>
      limit("agents.create", {
        id: "helper",
        frontmatter: { scope: "root", role: "Builder", ...frontmatter },
      });
    // `where` left out means anywhere.
    expect(root({ account: "claude-globex" })).toContain("works only in globex. Give it where: [globex]");
    expect(root({ account: "claude-globex", where: ["anywhere"] })).toContain("works only in globex");
    expect(root({ account: "claude-globex", where: ["globex", "acme"] })).toContain("works only in globex");
    expect(root({ account: "claude-globex", where: ["globex"] })).toBe(undefined);
    expect(root({ account: "api-private" })).toBe(undefined);
    expect(
      limit("agents.update", { id: "helper", frontmatter: { scope: "root", account: "claude-acme" } }),
    ).toContain("works only in acme");
    expect(limit("agents.edit", { id: "boss", set: { account: "claude-acme" } })).toContain(
      "works only in acme",
    );
    expect(limit("agents.edit", { id: "globex-root", set: { where: ["anywhere"] } })).toContain(
      "works only in globex",
    );
    expect(limit("agents.edit", { id: "boss", set: { where: ["acme"] } })).toBe(undefined);
    // Editing something else leaves the owner's setup alone; a copy of a loose agent is refused.
    expect(limit("agents.edit", { id: "globex-loose", set: { model: "sonnet" } })).toBe(undefined);
    expect(limit("agents.duplicate", { id: "globex-loose", newId: "globex-copy" })).toContain(
      "works only in globex",
    );
    expect(limit("agents.duplicate", { id: "globex-root", newId: "globex-copy" })).toBe(undefined);
  });

  it("keeps git accounts, saved logins and SSH aliases with their org", () => {
    expect(
      limit("orgs.setGitAccount", { id: "globex", host: "gitlab.com", account: "acme-dev" }, world("globex")),
    ).toContain("git account of acme");
    expect(
      limit(
        "orgs.setGitAccount",
        { id: "globex", host: "gitlab.com", account: "globex-ci", ssh: "gitlab-acme" },
        world("globex"),
      ),
    ).toContain("pushes for acme");
    expect(limit("orgs.setGitAccount", { id: "acme", host: "gitlab.com", account: "acme-dev" })).toBe(
      undefined,
    );
    expect(limit("orgs.useSavedLogin", { id: "acme", host: "github.com", account: "globex-bot" })).toContain(
      "git account of globex",
    );
    // The gh login on github.com is Globex's account.
    expect(limit("orgs.useGitLogin", { id: "acme", via: "gh", host: "github.com" })).toContain(
      "a git account of globex",
    );
    expect(limit("orgs.useGitLogin", { id: "globex", via: "gh", host: "github.com" }, world("globex"))).toBe(
      undefined,
    );
    // A login majhi cannot place is the owner's to give.
    expect(limit("orgs.useGitLogin", { id: "acme", via: "gh", host: "bitbucket.org" })).toContain(
      "cannot tell whose",
    );
    expect(
      limit(
        "orgs.update",
        { id: "globex", git_accounts: [{ host: "gitlab.com", account: "acme-dev" }] },
        world("globex"),
      ),
    ).toContain("git account of acme");
  });

  it("never attaches another org's connection to a task, nor brings in another org's account", () => {
    expect(limit("tasks.create", { text: "check the db", connections: ["globex-db"] })).toContain(
      "belongs to globex",
    );
    expect(limit("tasks.create", { text: "check the cluster", connections: ["acme-k8s"] })).toBe(undefined);
    // A task with no repos and no parent has no org, so Acme's cluster is not its to name.
    expect(limit("tasks.create", { text: "check", connections: ["acme-k8s"] }, world("private"))).toContain(
      "a task of private cannot have it",
    );
    // An agent's account goes into every task it works in: Globex's account never works for Acme.
    const glx = "@globex-root works on globex's account claude-globex, so it cannot work in a task of acme";
    expect(limit("team.add", { task: "ACM-1", agent: "globex-root" })).toBe(`Refused: ${glx}.`);
    expect(limit("tasks.addAgent", { id: "ACM-1", agent: "globex-root" })).toContain(glx);
    expect(limit("tasks.update", { id: "ACM-1", agent: "globex-root" })).toContain(glx);
    expect(limit("tasks.create", { text: "x", team: ["acme-builder", "globex-root"] })).toContain(glx);
    expect(
      limit("tasks.split", { task: "ACM-1", children: [{ text: "y", agent: "globex-root" }] }),
    ).toContain(glx);
    expect(limit("team.swap", { task: "ACM-1", agent: "acme-builder", with: "globex-root" })).toContain(glx);
    expect(limit("team.add", { task: "GLX-1", agent: "globex-root" }, world("globex"))).toBe(undefined);
    // A private account is the owner's own: the captain may join any task, whatever connections it lists.
    expect(limit("team.add", { task: "ACM-1", agent: "boss" })).toBe(undefined);
    expect(limit("tasks.addAgent", { id: "ACM-1", agent: "acme-builder" })).toBe(undefined);
  });

  it("refuses secrets in any text, and secret values passed at all", () => {
    const key = `sk-ant-api03-${"Ab3dE5gH7jK9mN1pQ3sT5vX7zB9".repeat(2)}`;
    expect(limit("tasks.create", { text: `use ${key} to call the API` })).toContain(
      "text holds what looks like a secret",
    );
    expect(
      limit("tasks.split", { task: "ACM-1", children: [{ text: `token=${"x7Kp2Lq9Zr4Vt8Wm"}` }] }),
    ).toContain("children.0.text");
    expect(limit("autonomy.note", { text: "fine" }, world(), `the key is ${key}`)).toContain("reason holds");
    expect(
      limit("autonomy.plan", {
        items: [{ title: "x", why: `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}` }],
      }),
    ).toContain("items.0.why");
    expect(limit("connections.setSecret", { id: "acme-k8s", field: "token", value: "hunter2" })).toContain(
      "never passes a secret's value",
    );
    expect(limit("secrets.save", { value: "hunter2" })).toContain("never passes a secret's value");
    // A connection's file has no reference form: only the owner sets one.
    expect(limit("connections.setFile", { id: "acme-k8s", field: "kubeconfig", upload: "up-1" })).toContain(
      "never sets a connection's file",
    );
    // A key is text too.
    expect(limit("autonomy.answer", { task: "ACM-1", item: "ask:1", answers: { [key]: "pg" } })).toContain(
      "a key in answers holds what looks like a secret",
    );
    // A reference is not a secret.
    expect(limit("tasks.create", { text: "token: secret:acme-gitlab" })).toBe(undefined);
  });

  it("never force-pushes, pushes with a merge only where Push is the captain's, never deletes a worktree after a push", () => {
    expect(limit("tasks.merge", { id: "ACM-1", push: true })).toContain("pushing is the owner's");
    // The card's and the pending ship's merge-and-push are pushes with a merge too.
    expect(limit("room.cardAction", { task: "ACM-1", item: "review:1", action: "mergePush" })).toContain(
      "pushing is the owner's",
    );
    expect(limit("tasks.resolveShip", { id: "ACM-1", action: "mergePush" })).toContain(
      "pushing is the owner's",
    );
    // Where the ship decision gives the captain Push for that task, the merge may push: the chore's rule.
    const pushes = { command: "tasks.merge", input: { id: "ACM-1", push: true }, pushDecides: true };
    expect(hardLimit(pushes, world())).toBe(undefined);
    expect(limit("room.cardAction", { task: "ACM-1", item: "review:1", action: "push" })).toBe(undefined);
    expect(limit("tasks.resolveShip", { id: "ACM-1", action: "merge" })).toBe(undefined);
    // No ship deletes its worktree after it, on any command.
    for (const [command, input] of [
      ["tasks.push", { id: "ACM-1", deleteAfter: true }],
      ["tasks.merge", { id: "ACM-1", deleteAfter: true }],
      ["tasks.resolveShip", { id: "ACM-1", action: "merge", deleteAfter: true }],
      ["room.cardAction", { task: "ACM-1", item: "review:1", action: "merge", deleteAfter: true }],
    ] as const) {
      expect([command, limit(command, input)]).toEqual([
        command,
        expect.stringContaining("never deletes a worktree"),
      ]);
    }
    expect(limit("tasks.push", { id: "ACM-1", deleteAfter: false })).toBe(undefined);
    expect(limit("tasks.remove", { id: "ACM-1", force: true })).toContain("over uncommitted work");
    // Merged without the host's word would count as shipped when nothing was.
    expect(limit("tasks.markMerged", { id: "ACM-1", force: true })).toContain("without its host's word");
    expect(limit("tasks.markMerged", { id: "ACM-1", force: false })).toBe(undefined);
    // The captain pushes with tasks.push only: its tools offer no push on a merge and no force anywhere.
    const tools = adminTools();
    const props = (command: string) =>
      Object.keys(tools.find((t) => t.command === command)?.inputSchema.properties ?? {});
    expect(props("tasks.merge")).not.toContain("push");
    expect(props("tasks.push")).not.toContain("force");
    expect(props("tasks.remove")).not.toContain("force");
  });
});

describe("decideAutonomously: the authority rows", () => {
  const withRows = (rows: Record<string, "decide" | "ask">): PolicyContext =>
    ctx({ settings: AutonomySettingsSchema.parse({ orgs: { acme: { authority: { ...RUNS, ...rows } } } }) });

  it("starts work only where the captain decides when work starts", () => {
    expect(decide(call("tasks.start", { id: "ACM-1" }), withRows({ start: "decide" }))).toBe("approved");
    expect(decideAutonomously(call("tasks.start", { id: "ACM-1" }), withRows({ start: "ask" }))).toEqual({
      decision: "left",
      why: "In acme you decide when work starts, so the captain does not start it",
    });
  });

  it("merges only where the captain decides when work is merged", () => {
    expect(decide(call("tasks.merge", { id: "ACM-1" }), withRows({ merge: "decide" }))).toBe("approved");
    expect(decide(call("tasks.merge", { id: "ACM-1" }), withRows({ merge: "ask" }))).toBe("left");
    // A push row on "decide" does not allow a merge, and the other way round.
    expect(decide(call("tasks.merge", { id: "ACM-1" }), withRows({ push: "decide", merge: "ask" }))).toBe(
      "left",
    );
  });

  it("pushes and opens merge requests only where the captain decides when work is pushed", () => {
    for (const command of ["tasks.push", "tasks.openMrs"] as const) {
      expect(decide(call(command, { id: "ACM-1" }), withRows({ push: "decide" }))).toBe("approved");
      expect(decide(call(command, { id: "ACM-1" }), withRows({ push: "ask", merge: "decide" }))).toBe("left");
    }
  });
});

describe("what follows the Merge row and Upkeep for the captain's own calls", () => {
  it("lets the captain ask the lead to resolve conflicts only where Merge is Captain", () => {
    const resolve = { id: "GLX-1", action: "merge" };
    // Globex merges; Acme asks.
    expect(decide(call("tasks.resolveShip", resolve, { org: "globex", boss: true }))).toBe("approved");
    expect(decide(call("tasks.resolveShip", resolve, { org: "acme", boss: true }))).toBe("left");
    // An agent of a task is not the captain: it stays a decision even where Merge is Captain.
    expect(decide(call("tasks.resolveShip", resolve, { org: "globex" }))).toBe("left");
    // The push row is its own: Acme may push, and still cannot resolve a merge without the Merge row.
    expect(decide(call("tasks.push", { id: "ACM-1" }))).toBe("approved");
    expect(decide(call("tasks.resolveShip", { id: "ACM-1" }, { boss: true }))).toBe("left");
  });

  it("lets the captain register a repo only under Upkeep, and never an agent", () => {
    const register = { id: "acme-web", org: "acme", path: "/Users/owner/Work/acme/web" };
    expect(decide(call("projects.register", register, { boss: true }))).toBe("approved");
    expect(decide(call("projects.register", register))).toBe("left");
    const quiet = AutonomySettingsSchema.parse({
      orgs: { acme: { authority: { ...RUNS, upkeep: "ask" } } },
    });
    expect(decide(call("projects.register", register, { boss: true }), ctx({ settings: quiet }))).toBe(
      "left",
    );
    // The rest of what agents reach stays the owner's.
    expect(decide(call("projects.update", { id: "acme-web" }, { boss: true }))).toBe("left");
    expect(decide(call("projects.remove", { id: "acme-web" }, { boss: true }))).toBe("left");
  });
});
