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
  const details = new Map<string, string>();
  return {
    filed,
    details,
    find: (_org: string, key: string) => (filed.has(key) ? { status: filed.get(key) } : undefined),
    report: async (input: { dedupeKey?: string; title: string; detail?: string }) => {
      filed.set(input.dedupeKey ?? input.title, "open");
      details.set(input.dedupeKey ?? input.title, input.detail ?? "");
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
  org?: string;
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
      org: opts.org ?? "acme",
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
});

describe("the disk", () => {
  const GB = 1_000_000_000;
  const quiet: Partial<UpkeepPorts> = {
    failingConnections: async () => [],
    staleSecrets: async () => [],
    tidy: async () => [],
  };
  const disk = (over: Partial<NonNullable<UpkeepPorts["disk"]>>): NonNullable<UpkeepPorts["disk"]> => ({
    reading: () => ({ freeBytes: 200 * GB, totalBytes: 1000 * GB, low: false }),
    docker: async () => ({ images: 0, volumes: 0, bytes: 0 }),
    freeDocker: async () => ({ images: 0, volumes: 0, bytes: 0 }),
    plan: async () => ({ bytes: 0, lines: [] }),
    consumers: async () => [],
    ...over,
  });

  it("removes unused Docker images and old volumes on a tidy run, and says so in one line", async () => {
    const freeDocker = vi.fn(async () => ({ images: 3, volumes: 2, bytes: 9 * GB }));
    const t = setup({
      upkeep: {
        ...quiet,
        disk: disk({ docker: async () => ({ images: 3, volumes: 2, bytes: 9 * GB }), freeDocker }),
      },
    });
    await t.runner.start("acme", "tidy", "daily");
    expect(freeDocker).toHaveBeenCalledOnce();
    expect(t.repo.allActions().map((a) => a.text)).toContain(
      "Removed 3 unused Docker images (9.0 GB) and 2 volumes of old tasks",
    );
  });

  it("does nothing to Docker when nothing qualifies", async () => {
    const freeDocker = vi.fn();
    const t = setup({ upkeep: { ...quiet, disk: disk({ freeDocker }) } });
    await t.runner.start("acme", "tidy", "daily");
    expect(freeDocker).not.toHaveBeenCalled();
  });

  it("frees task folders at once when the disk is low, and files no card when that is enough", async () => {
    const freeFolders = vi.fn(async () => ({ bytes: 100 * GB, tasks: [] }));
    const t = setup({
      org: "private",
      upkeep: {
        ...quiet,
        disk: disk({ reading: () => ({ freeBytes: 20 * GB, totalBytes: 500 * GB, low: true }) }),
      },
      ports: { freeFolders },
    });
    await t.runner.start("private", "tidy", "The disk is low");
    expect(freeFolders).toHaveBeenCalledOnce();
    expect(t.findings.filed.size).toBe(0);
  });

  it("files one card with the biggest consumers and what one click removes when the disk stays low", async () => {
    const t = setup({
      org: "private",
      upkeep: {
        ...quiet,
        disk: disk({
          reading: () => ({ freeBytes: 10 * GB, totalBytes: 500 * GB, low: true }),
          plan: async () => ({ bytes: 12 * GB, lines: ["8 unused Docker images (12.0 GB)"] }),
          consumers: async () => ["Task folders 30.0 GB", "Docker images 45.0 GB"],
        }),
      },
      ports: { freeFolders: async () => ({ bytes: GB, tasks: [] }) },
    });
    await t.runner.start("private", "tidy", "The disk is low");
    const [key] = [...t.findings.filed.keys()];
    expect(key).toBe("disk:low:2026-10-04");
    expect(t.findings.details.get(key ?? "")).toBe(
      "Biggest: Task folders 30.0 GB, Docker images 45.0 GB. One click would remove: 8 unused Docker images (12.0 GB). Press Free 12.0 GB in Health to remove exactly this.",
    );
  });
});

describe("agent slots", () => {
  const slots = (limit: number): Partial<UpkeepPorts> => {
    const s: AccountSlots = { account: "main", inUse: limit, waiting: 2, limit, free: 0, headroom: true };
    return { checklist: async () => [], slots: async () => [s] };
  };

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
