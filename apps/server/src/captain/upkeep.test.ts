import { ALL_ASK, type Authority, type AutonomyOrg } from "@majhi/shared";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../store/index.ts";
import { createChores } from "./chores.ts";
import type { CaptainPorts } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner, type RunnerDeps } from "./runner.ts";
import type { AccountSlots, Candidate, UpkeepPorts } from "./upkeep-ports.ts";

const NOW = new Date("2026-10-04T12:00:00.000Z");

/** A findings store that keeps what was filed, by dedupe key, and what the owner dismissed. */
function fakeFindings(dismissed: string[] = []) {
  const filed = new Map<string, string>(dismissed.map((k) => [k, "dismissed"]));
  return {
    filed,
    find: (_org: string, key: string) => (filed.has(key) ? { status: filed.get(key) } : undefined),
    report: async (input: { dedupeKey?: string; title: string }) => {
      filed.set(input.dedupeKey ?? input.title, "open");
      return {};
    },
    settle: (_org: string, _source: string, prefix: string, stillTrue: ReadonlySet<string>) => {
      let n = 0;
      for (const [k, v] of filed) {
        if (v === "open" && k.startsWith(prefix) && !stillTrue.has(k)) {
          filed.set(k, "fixed");
          n += 1;
        }
      }
      return n;
    },
  };
}

const mcp = (id: string): Candidate => ({
  kind: "mcp",
  id,
  title: id,
  description: "A server",
  installed: false,
});
const skill = (id: string, installs: number): Candidate => ({
  kind: "skill",
  id,
  title: id,
  description: "A skill",
  source: `acme/${id}`,
  installs,
  installed: false,
  install: { source: `acme/${id}`, skill: id.split("/").pop() as string },
});

function setup(opts: {
  upkeep: Partial<UpkeepPorts>;
  ports?: Partial<CaptainPorts>;
  findings?: ReturnType<typeof fakeFindings>;
  authority?: Partial<Authority>;
  rules?: AutonomyOrg;
}) {
  const findings = opts.findings ?? fakeFindings();
  const ports = {
    cleanable: async () => [],
    ...opts.ports,
    findings,
    upkeep: opts.upkeep as UpkeepPorts,
  } as unknown as CaptainPorts;
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const runner = new ChoreRunner({
    repo,
    now: () => NOW,
    workspace: async () => ({
      org: "acme",
      name: "Acme",
      mode: "on",
      authority: { ...ALL_ASK, upkeep: "decide", ...opts.authority } as Authority,
      rules: opts.rules,
      tz: "UTC",
      day: "2026-10-04",
    }),
    stopped: () => false,
    tellOwner: () => {},
    laneTokens: () => 0,
    chores: createChores(ports, () => NOW) as RunnerDeps["chores"],
  });
  return { repo, runner, findings };
}

describe("discover", () => {
  const search = async (kind: Candidate["kind"]) =>
    kind === "mcp" ? [mcp("io.acme/postgres"), mcp("io.acme/rejected")] : [skill("acme/lint", 900)];

  it("never proposes a tool the owner turned down", async () => {
    const t = setup({
      findings: fakeFindings(["discover:mcp:io.acme/rejected"]),
      upkeep: { profile: async () => ["postgres"], search },
    });
    await t.runner.start("acme", "discover", "daily");
    expect([...t.findings.filed.keys()].toSorted()).toEqual([
      "discover:mcp:io.acme/postgres",
      "discover:mcp:io.acme/rejected",
      "discover:skill:acme/lint",
    ]);
    expect(t.findings.filed.get("discover:mcp:io.acme/rejected")).toBe("dismissed");
    expect(t.repo.allActions().map((a) => a.text)).toEqual([
      "Suggests the skill acme/lint",
      "Suggests the MCP server io.acme/postgres",
      "Discover tools: proposed 2",
    ]);
  });

  it("installs a skill only with full access, and still proposes an MCP server", async () => {
    const installSkill = vi.fn(async () => {});
    const plain = setup({ upkeep: { profile: async () => ["x"], search, installSkill } });
    await plain.runner.start("acme", "discover", "daily");
    expect(installSkill).not.toHaveBeenCalled();
    const full = setup({
      upkeep: { profile: async () => ["x"], search, installSkill },
      rules: { fullAccess: true } as AutonomyOrg,
    });
    await full.runner.start("acme", "discover", "daily");
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(full.repo.allActions().map((a) => a.text)).toContain("Installed the skill acme/lint");
    expect(full.findings.filed.has("discover:mcp:io.acme/postgres")).toBe(true);
  });

  it("a skill that fails to install fails once with its reason and is never tried again", async () => {
    const installSkill = vi.fn(async () => {
      throw new Error("The description is longer than 1024 characters.");
    });
    const full = setup({
      upkeep: { profile: async () => ["x"], search, installSkill },
      rules: { fullAccess: true } as AutonomyOrg,
    });
    for (const day of [1, 2, 3]) {
      await full.runner.start("acme", "discover", `daily${day}`);
    }
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(full.findings.filed.get("discover:skill:acme/lint")).toBe("open");
    expect(full.repo.allActions().map((a) => a.text)).toContain(
      "Could not install the skill acme/lint: The description is longer than 1024 characters.",
    );
  });

  it("proposes a skill whose registry id is not a valid local name, and never installs it", async () => {
    const installSkill = vi.fn(async () => {});
    const odd = {
      ...skill("acme/react:components", 900),
      install: { source: "acme/ui", skill: "react:components" },
    };
    const full = setup({
      upkeep: {
        profile: async () => ["x"],
        search: async (kind) => (kind === "skill" ? [odd] : []),
        installSkill,
      },
      rules: { fullAccess: true } as AutonomyOrg,
    });
    await full.runner.start("acme", "discover", "daily");
    expect(installSkill).not.toHaveBeenCalled();
    expect(full.findings.filed.size).toBe(1);
  });
});

describe("tidy stale secret requests", () => {
  it("withdraws a request that is no longer needed and leaves one that is", async () => {
    const pending = new Map([
      ["secret:a", "waiting"],
      ["secret:b", "waiting"],
    ]);
    const withdrawn: string[] = [];
    const t = setup({
      upkeep: {
        failingConnections: async () => [],
        tidy: async () => [],
        staleSecrets: async () =>
          [...pending.keys()].map((item) => ({
            task: "ACM-1",
            item,
            label: "A key",
            obsolete: item === "secret:a" ? "Its task is closed" : undefined,
          })),
        withdrawSecret: async (_task, item, reason) => {
          withdrawn.push(`${item}: ${reason}`);
          pending.delete(item);
        },
      },
    });
    await t.runner.start("acme", "tidy", "daily");
    expect(withdrawn).toEqual(["secret:a: Its task is closed"]);
    expect([...pending.keys()]).toEqual(["secret:b"]);
  });
});

describe("tidy", () => {
  it("never removes a worktree with uncommitted changes, and names it for the owner", async () => {
    const clean = vi.fn(async () => ({ removed: [], kept: [] }));
    const t = setup({
      upkeep: { failingConnections: async () => [], staleSecrets: async () => [], tidy: async () => [] },
      ports: {
        clean,
        cleanable: async () => [
          { id: "ACM-1", title: "Done", steps: ["remove worktree"], dirty: ["src/a.ts has changes"] },
        ],
      },
    });
    await t.runner.start("acme", "tidy", "daily");
    expect(clean).not.toHaveBeenCalled();
    expect(t.findings.filed.get("tidy:dirty:ACM-1")).toBe("open");
  });

  it("resolves the dirty-worktree finding once the worktree is clean, and keeps one finding per task", async () => {
    let dirty = ["src/a.ts has changes"];
    const t = setup({
      upkeep: { failingConnections: async () => [], staleSecrets: async () => [], tidy: async () => [] },
      ports: { cleanable: async () => [{ id: "ACM-1", title: "Done", steps: [], dirty }] },
    });
    await t.runner.start("acme", "tidy", "daily");
    await t.runner.start("acme", "tidy", "daily");
    expect([...t.findings.filed.entries()]).toEqual([["tidy:dirty:ACM-1", "open"]]);
    dirty = [];
    await t.runner.start("acme", "tidy", "daily");
    expect(t.findings.filed.get("tidy:dirty:ACM-1")).toBe("fixed");
  });
});

describe("the upkeep row", () => {
  const quiet: Partial<UpkeepPorts> = { profile: async () => [], search: async () => [] };

  it("finds the same state on a second run and adds no second line", async () => {
    const t = setup({ upkeep: quiet });
    expect(await t.runner.start("acme", "discover", "daily")).toBe("done");
    expect(await t.runner.start("acme", "discover", "daily")).toBe("done");
    expect(t.repo.allActions().map((a) => a.text)).toEqual(["Discover tools: nothing new fits"]);
  });

  it("does not run where Upkeep is You", async () => {
    const t = setup({ upkeep: quiet, authority: { upkeep: "ask" } });
    expect(await t.runner.start("acme", "discover", "daily")).toBeUndefined();
    expect(t.repo.allActions()).toEqual([]);
  });
});

describe("agent slots", () => {
  const slots = (limit: number): Partial<UpkeepPorts> => {
    const s: AccountSlots = { account: "main", inUse: limit, waiting: 2, limit, free: 0, headroom: true };
    return { checklist: async () => [], slots: async () => [s] };
  };

  it("raises the limit by one with full access", async () => {
    const setAccountSlots = vi.fn(async () => {});
    const t = setup({
      upkeep: { ...slots(2), setAccountSlots },
      rules: { fullAccess: true } as AutonomyOrg,
    });
    await t.runner.start("acme", "checklist", "daily");
    expect(setAccountSlots).toHaveBeenCalledWith(3);
  });

  it("never raises past 4", async () => {
    const setAccountSlots = vi.fn(async () => {});
    const t = setup({
      upkeep: { ...slots(4), setAccountSlots },
      rules: { fullAccess: true } as AutonomyOrg,
    });
    await t.runner.start("acme", "checklist", "daily");
    expect(setAccountSlots).not.toHaveBeenCalled();
    expect(t.findings.filed.has("slots:main:4")).toBe(true);
  });

  it("never raises while the machine is busy", async () => {
    const setAccountSlots = vi.fn(async () => {});
    const t = setup({
      upkeep: {
        ...slots(2),
        setAccountSlots,
        machineBusy: () => "the machine is busy: load 30.0 on 10 cores",
      },
      rules: { fullAccess: true } as AutonomyOrg,
    });
    await t.runner.start("acme", "checklist", "daily");
    expect(setAccountSlots).not.toHaveBeenCalled();
    expect(t.findings.filed.has("slots:main:2")).toBe(true);
  });

  it("asks the owner without full access", async () => {
    const setAccountSlots = vi.fn(async () => {});
    const t = setup({ upkeep: { ...slots(2), setAccountSlots } });
    await t.runner.start("acme", "checklist", "daily");
    expect(setAccountSlots).not.toHaveBeenCalled();
    expect(t.findings.filed.has("slots:main:2")).toBe(true);
  });
});
