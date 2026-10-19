import { dockerRunArgs, NETGUARD, NETGUARD_CAPS } from "@majhi/acp";
import { describe, expect, it } from "vitest";
import { BrowserService } from "./service.ts";
import { TestBrowserService } from "./test-service.ts";

/** A docker that records `run` calls and answers the few reads the service makes. */
function fakeDocker() {
  const runs: string[][] = [];
  const networks = new Map<string, string>();
  const running = new Set<string>();
  const docker = async (args: string[]): Promise<string> => {
    const [cmd, sub] = args;
    if (cmd === "run") {
      runs.push(args);
      running.add(args[args.indexOf("--name") + 1] ?? "");
      return "id";
    }
    if (cmd === "logs") {
      return args.some((a) => a.includes("testbrowser"))
        ? "majhi-testbrowserd ready"
        : "majhi-browserd ready";
    }
    if (cmd === "inspect") {
      const name = args[args.length - 1] ?? "";
      if (args.includes("{{.State.Running}}")) return running.has(name) ? "true" : "false";
      throw new Error("no such container");
    }
    if (cmd === "network" && sub === "inspect") {
      const subnet = networks.get(args[2] ?? "");
      if (subnet === undefined) throw new Error("no such network");
      return `${subnet} `;
    }
    if (cmd === "network" && sub === "ls") return [...networks.keys()].join("\n");
    if (cmd === "network" && sub === "create") {
      networks.set(args[args.length - 1] ?? "", args[args.indexOf("--subnet") + 1] ?? "");
      return "";
    }
    return "";
  };
  return { docker, runs };
}

const mounts = (run: string[]): string[] =>
  run.filter((_, i) => run[i - 1] === "--mount").map((m) => m.split(",")[1] ?? "");

describe("a workspace's browser container", () => {
  it("is never shared: each workspace has its own container, network and profile folders, and its tasks join only its own", async () => {
    const { docker, runs } = fakeDocker();
    const profiles: Record<string, { id: string; dir: string }[]> = {
      acme: [{ id: "acme-web", dir: "/Users/owner/.majhi/connections/acme-web/profile" }],
      globex: [{ id: "globex-web", dir: "/Users/owner/.majhi/connections/globex-web/profile" }],
    };
    const service = new BrowserService({
      image: "majhi-browser:dev",
      runner: () => ({
        docker: "docker",
        cliEnv: {},
        majhiHome: "/Users/owner/.majhi",
        protectedPaths: ["/Users/owner/.config/majhi/secrets.key"],
      }),
      profiles: async (org) => profiles[org] ?? [],
      prepareDir: async () => undefined,
      docker,
    });

    const a = await service.endpoint("ACM-1", "acme", "acme-web");
    const g = await service.endpoint("GLO-1", "globex", "globex-web");

    expect(a).toEqual({ endpoint: "http://majhi-browser-acme:9300" });
    expect(g).toEqual({ endpoint: "http://majhi-browser-globex:9300" });
    expect(runs.map((r) => r[r.indexOf("--name") + 1])).toEqual([
      "majhi-browser-acme",
      "majhi-browser-globex",
    ]);
    expect(runs.map((r) => r[r.indexOf("--network") + 1])).toEqual([
      "majhi-browser-acme",
      "majhi-browser-globex",
    ]);
    expect(mounts(runs[0] ?? [])).toEqual(["source=/Users/owner/.majhi/connections/acme-web/profile"]);
    expect(mounts(runs[1] ?? [])).toEqual(["source=/Users/owner/.majhi/connections/globex-web/profile"]);
    expect(service.networksOf("ACM-1")).toEqual(["majhi-browser-acme"]);
    expect(service.networksOf("GLO-1")).toEqual(["majhi-browser-globex"]);
    expect(service.subnetsOf("ACM-1")).toEqual(["10.211.0.2/32"]);
    expect(service.subnetsOf("GLO-1")).toEqual(["10.211.1.2/32"]);
    // A connection of another workspace is not served by this workspace's browser.
    expect(await service.endpoint("ACM-1", "acme", "globex-web")).toEqual({
      problem: "globex-web has no browser here.",
    });

    // The test browser is the same: one container per workspace, found from the run's task.
    const tb = fakeDocker();
    const orgs: Record<string, string> = {
      "ACM-1": "acme",
      "ACM-2": "acme",
      "GLO-1": "globex",
      "PRV-1": "private",
    };
    const testBrowser = new TestBrowserService({
      image: "majhi-testbrowser:dev",
      network: "majhi-runners",
      runner: () => ({ docker: "docker", cliEnv: {}, user: "501:20" }),
      orgOf: (task) => orgs[task] ?? "private",
      docker: tb.docker,
    });
    expect(await testBrowser.ensureFor("ACM-1")).toBe("majhi-testbrowser-acme");
    expect(await testBrowser.ensureFor("GLO-1")).toBe("majhi-testbrowser-globex");
    expect(await testBrowser.ensureFor("ACM-2")).toBe("majhi-testbrowser-acme");
    expect(await testBrowser.ensureFor("PRV-1")).toBe("majhi-testbrowser-private");
    expect(tb.runs.map((r) => r[r.indexOf("--name") + 1])).toEqual([
      "majhi-testbrowser-acme",
      "majhi-testbrowser-globex",
      "majhi-testbrowser-private",
    ]);
    // No folder of the computer is mounted, and each carries its own workspace's label.
    for (const run of tb.runs) expect(run).not.toContain("--mount");
    expect(tb.runs.map((r) => r.filter((_, i) => r[i - 1] === "--label"))).toEqual([
      ["majhi.container=testbrowser", "majhi.org=acme"],
      ["majhi.container=testbrowser", "majhi.org=globex"],
      ["majhi.container=testbrowser", "majhi.org=private"],
    ]);
  });
});

/** The flags that decide what a container may reach: what it keeps, and what runs first inside it. */
function guardOf(run: string[], image: string) {
  const values = (flag: string) => run.filter((_, i) => run[i - 1] === flag);
  const at = run.indexOf(image);
  return {
    drop: values("--cap-drop"),
    add: values("--cap-add"),
    security: values("--security-opt"),
    entry: run.slice(at + 1, at + 3),
    // Nothing private is let through for a container without a task network or a server.
    allowed: values("--allow"),
    privileged: run.includes("--privileged"),
  };
}

describe("the containers that run a browser", () => {
  it("start under the same private-range guard as a runner, so none reaches the LAN, the VPN or metadata", async () => {
    const runner = {
      docker: "docker",
      cliEnv: {},
      user: "501:20",
      majhiHome: "/Users/owner/.majhi",
      protectedPaths: ["/Users/owner/.config/majhi/secrets.key"],
    };
    const fromRunner = dockerRunArgs(
      { command: { command: "agent", args: [] }, env: {}, cwd: "/tmp", scratch: true },
      { ...runner, image: "majhi-runner:dev", network: "majhi-runners" },
      "majhi-run-1",
    );

    const { docker, runs } = fakeDocker();
    await new BrowserService({
      image: "majhi-browser:dev",
      runner: () => runner,
      profiles: async () => [{ id: "acme-web", dir: "/Users/owner/.majhi/connections/acme-web/profile" }],
      prepareDir: async () => undefined,
      docker,
    }).endpoint("ACM-1", "acme", "acme-web");
    const testRuns: string[][] = [];
    await new TestBrowserService({
      image: "majhi-testbrowser:dev",
      network: "majhi-runners",
      runner: () => runner,
      orgOf: () => "acme",
      docker: async (args) => {
        if (args[0] === "run") testRuns.push(args);
        return args[0] === "logs" ? "majhi-testbrowserd ready" : "";
      },
    }).ensureFor("ACM-1");

    const expected = guardOf(fromRunner, "majhi-runner:dev");
    expect(expected).toEqual({
      drop: ["ALL"],
      add: NETGUARD_CAPS,
      security: ["no-new-privileges"],
      entry: [NETGUARD, "501:20"],
      allowed: [],
      privileged: false,
    });
    expect(guardOf(runs[0] ?? [], "majhi-browser:dev")).toEqual(expected);
    expect(guardOf(testRuns[0] ?? [], "majhi-testbrowser:dev")).toEqual(expected);
  });
});
