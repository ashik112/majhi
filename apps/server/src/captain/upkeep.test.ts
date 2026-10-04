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
  };
}

const mcp = (id: string): Candidate => ({ kind: "mcp", id, title: id, description: "A server", installed: false });
const skill = (id: string, installs: number): Candidate => ({
  kind: "skill",
  id,
  title: id,
  description: "A skill",
  source: `acme/${id}`,
  installs,
  installed: false,
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
    caused: () => {},
    laneTokens: () => 0,
    chores: createChores(ports, () => NOW) as RunnerDeps["chores"],
    capAsked: () => {},
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
});

describe("tidy", () => {
  it("never removes a worktree with uncommitted changes, and names it for the owner", async () => {
    const clean = vi.fn(async () => ({ removed: [], kept: [] }));
    const t = setup({
      upkeep: { failingConnections: async () => [], tidy: async () => [] },
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
});

describe("the caps and the upkeep row", () => {
  const quiet: Partial<UpkeepPorts> = { profile: async () => [], search: async () => [] };

  it("runs once a day", async () => {
    const t = setup({ upkeep: quiet });
    expect(await t.runner.start("acme", "discover", "daily")).toBe("done");
    expect(await t.runner.start("acme", "discover", "daily")).toBeUndefined();
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

  it("asks the owner without full access", async () => {
    const setAccountSlots = vi.fn(async () => {});
    const t = setup({ upkeep: { ...slots(2), setAccountSlots } });
    await t.runner.start("acme", "checklist", "daily");
    expect(setAccountSlots).not.toHaveBeenCalled();
    expect(t.findings.filed.has("slots:main:2")).toBe(true);
  });
});
