import { describe, expect, it } from "vitest";
import { TestBrowserService } from "./test-service.ts";

/** A docker that records `run` calls and says a container is running once it was started. */
function fakeDocker() {
  const runs: string[][] = [];
  const running = new Set<string>();
  const docker = async (args: string[]): Promise<string> => {
    const [cmd] = args;
    if (cmd === "run") {
      runs.push(args);
      running.add(args[args.indexOf("--name") + 1] ?? "");
      return "id";
    }
    if (cmd === "logs") return "majhi-testbrowserd ready";
    if (cmd === "inspect") return running.has(args[args.length - 1] ?? "") ? "true" : "false";
    return "";
  };
  return { docker, runs };
}

describe("a workspace's test browser", () => {
  it("is never shared: each workspace gets its own container, found from the run's task and not from the request", async () => {
    const { docker, runs } = fakeDocker();
    const orgs: Record<string, string> = {
      "ACM-1": "acme",
      "ACM-2": "acme",
      "GLO-1": "globex",
      "PRV-1": "private",
    };
    const service = new TestBrowserService({
      image: "majhi-testbrowser:dev",
      network: "majhi-runners",
      runner: () => ({ docker: "docker", cliEnv: {}, user: "501:20" }),
      orgOf: (task) => orgs[task] ?? "private",
      docker,
    });

    expect(await service.ensureFor("ACM-1")).toBe("majhi-testbrowser-acme");
    expect(await service.ensureFor("GLO-1")).toBe("majhi-testbrowser-globex");
    // A second task of the same workspace uses the container that already runs; a task with no workspace gets Private's.
    expect(await service.ensureFor("ACM-2")).toBe("majhi-testbrowser-acme");
    expect(await service.ensureFor("PRV-1")).toBe("majhi-testbrowser-private");

    expect(runs.map((r) => r[r.indexOf("--name") + 1])).toEqual([
      "majhi-testbrowser-acme",
      "majhi-testbrowser-globex",
      "majhi-testbrowser-private",
    ]);
    // No folder of the computer is mounted into any of them, and each carries its own workspace's label.
    for (const run of runs) expect(run).not.toContain("--mount");
    expect(runs.map((r) => r.filter((_, i) => r[i - 1] === "--label"))).toEqual([
      ["majhi.container=testbrowser", "majhi.org=acme"],
      ["majhi.container=testbrowser", "majhi.org=globex"],
      ["majhi.container=testbrowser", "majhi.org=private"],
    ]);
  });
});
