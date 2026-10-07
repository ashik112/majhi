import { imageCommandProblem, mongoCommandProblem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { ContainerRefused, dbCheckRunArgs, dockerArgv } from "../../containers/args.ts";
import { refused } from "./db-drivers.ts";
import { realWatchPorts } from "./real-ports.ts";

const ports = realWatchPorts({
  fetch,
  lookup: async () => [],
  now: () => new Date(),
  connection: async () => undefined,
  monitor: async () => ({}),
  pathPrint: async () => "missing",
});

describe("a write is refused before any connection", () => {
  it("MongoDB", async () => {
    await expect(
      ports.sql("mongodb", "mongodb://127.0.0.1:1/db", '{"command":"insert","collection":"a"}', 500),
    ).rejects.toThrow();
  });
});

describe("MongoDB command allow list", () => {
  it("refuses everything outside the read commands", () => {
    for (const command of ["insert", "delete", "update", "drop", "aggregate", "eval", "shutdown"]) {
      expect(mongoCommandProblem(JSON.stringify({ command, collection: "orders", path: "n" }))).toBeDefined();
    }
  });

  it("refuses code and write operators anywhere in a filter", () => {
    const filter = (query: unknown) => JSON.stringify({ command: "count", collection: "orders", query });
    expect(mongoCommandProblem(filter({ $where: "sleep(1000)" }))).toBeDefined();
    expect(mongoCommandProblem(filter({ a: { $or: [{ b: { $function: {} } }] } }))).toBeDefined();
    expect(mongoCommandProblem(filter({ $out: "x" }))).toBeDefined();
    expect(mongoCommandProblem(filter({ status: "open", n: { $gt: 3 } }))).toBeUndefined();
  });
});

describe("image checks", () => {
  const good = {
    image: "clickhouse/clickhouse-server:24",
    command: ["clickhouse-client", "--query", "SELECT count() FROM jobs"],
  };

  it("refuses the obvious write words and a shell", () => {
    for (const q of ["DROP TABLE jobs", "insert into jobs values (1)", "ALTER TABLE jobs", "TRUNCATE jobs"]) {
      expect(
        imageCommandProblem(JSON.stringify({ ...good, command: ["clickhouse-client", "--query", q] })),
      ).toBeDefined();
    }
    expect(
      imageCommandProblem(JSON.stringify({ ...good, command: ["sh", "-c", "clickhouse-client"] })),
    ).toBeDefined();
    expect(imageCommandProblem(JSON.stringify({ ...good, image: "--privileged" }))).toBeDefined();
    expect(imageCommandProblem(JSON.stringify({ ...good, extra: 1 }))).toBeDefined();
  });

  const safety = {
    majhiHome: "/Users/owner/.majhi",
    hostHome: "/Users/owner",
    protectedPaths: ["/Users/owner/keys/secrets.key"],
    task: "WATCH-1",
    runnerNetwork: "",
    taskFolder: "/",
  };

  it("runs in a locked-down throwaway container", () => {
    const argv = dockerArgv(
      dbCheckRunArgs(
        "majhi-dbcheck-0a1b2c3d4e5f",
        good.image,
        good.command,
        { CH_PASSWORD: "x" },
        { cpus: 1, memory: "512m" },
        safety,
      ),
    );
    expect(argv).toContain("--rm");
    expect(argv).toContain("--read-only");
    expect(argv).not.toContain("--mount");
    expect(argv).not.toContain("--publish");
    expect(argv.slice(-3)).toEqual(good.command);
  });

  it("mounts only the workspace's checked programs, read-only, and can run with no network", () => {
    const limits = { cpus: 1, memory: "512m" };
    const name = "majhi-dbcheck-0a1b2c3d4e5f";
    const bin = "/Users/owner/.majhi/tool-installs/acme/bin";
    const argv = dockerArgv(
      dbCheckRunArgs(name, good.image, good.command, {}, limits, safety, { toolsBin: bin, offline: true }),
    );
    expect(argv).toContain(`type=bind,source=${bin},target=/majhi-tools,readonly`);
    expect(argv.slice(argv.indexOf("--network"), argv.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    // Anything else under the home, or the writable tools folder a run can change, is refused.
    for (const toolsBin of [
      "/Users/owner/.majhi/tools/acme/bin",
      "/Users/owner/.majhi",
      "/Users/owner/.majhi/tool-installs/acme",
      "/Users/owner/.majhi/tool-installs/../secrets/bin",
      "/Users/owner/.ssh",
    ]) {
      expect(() => dbCheckRunArgs(name, good.image, good.command, {}, limits, safety, { toolsBin })).toThrow(
        ContainerRefused,
      );
    }
  });

  it("refuses a bad name, a host path and a flag as the image", () => {
    const limits = { cpus: 1, memory: "512m" };
    expect(() => dbCheckRunArgs("majhi-preview-x", good.image, good.command, {}, limits, safety)).toThrow(
      ContainerRefused,
    );
    expect(() =>
      dbCheckRunArgs(
        "majhi-dbcheck-0a1b2c3d4e5f",
        good.image,
        ["x", "/var/run/docker.sock"],
        {},
        limits,
        safety,
      ),
    ).toThrow(ContainerRefused);
    expect(() =>
      dbCheckRunArgs("majhi-dbcheck-0a1b2c3d4e5f", "--privileged", good.command, {}, limits, safety),
    ).toThrow(ContainerRefused);
  });
});

describe("driver failures", () => {
  it("never carry the driver's own text; a missing driver is a majhi problem", () => {
    expect(
      refused(new Error("password authentication failed for user bob at 10.0.0.5")).message,
    ).not.toContain("bob");
  });
});
