import {
  imageCommandProblem,
  mongoCommandProblem,
  parseImageCommand,
  parseMongoCommand,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { ContainerRefused, dbCheckRunArgs, dockerArgv } from "../../containers/args.ts";
import { ImageCheckFailed, MAJHI_DOCKER, runImageCheck } from "../../containers/image-check.ts";
import { Unavailable } from "./checks.ts";
import { type MongoReader, readMongo, refused } from "./db-drivers.ts";
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
  it("SQL", async () => {
    await expect(
      ports.sql("postgres", "postgres://a:b@127.0.0.1:1/db", "DELETE FROM t", 500),
    ).rejects.toThrow("only reads and the fixed fixes run");
    await expect(
      ports.sql("mysql", "mysql://a:b@127.0.0.1:1/db", "SELECT 1; DROP TABLE t", 500),
    ).rejects.toThrow(Unavailable);
  });

  it("MongoDB", async () => {
    await expect(
      ports.sql("mongodb", "mongodb://127.0.0.1:1/db", '{"command":"insert","collection":"a"}', 500),
    ).rejects.toThrow("Only count, dbStats");
  });
});

describe("MongoDB command allow list", () => {
  it("refuses everything outside the read commands", () => {
    for (const command of ["insert", "delete", "update", "drop", "aggregate", "eval", "shutdown"]) {
      expect(mongoCommandProblem(JSON.stringify({ command, collection: "orders", path: "n" }))).toContain(
        "may run on MongoDB",
      );
    }
  });

  it("refuses code and write operators anywhere in a filter", () => {
    const filter = (query: unknown) => JSON.stringify({ command: "count", collection: "orders", query });
    expect(mongoCommandProblem(filter({ $where: "sleep(1000)" }))).toContain("$where");
    expect(mongoCommandProblem(filter({ a: { $or: [{ b: { $function: {} } }] } }))).toContain("$function");
    expect(mongoCommandProblem(filter({ $out: "x" }))).toContain("$out");
    expect(mongoCommandProblem(filter({ status: "open", n: { $gt: 3 } }))).toBeUndefined();
  });

  it("refuses unknown fields, odd names and a missing path", () => {
    expect(mongoCommandProblem('{"command":"count","collection":"a","pipeline":[]}')).toContain("pipeline");
    expect(mongoCommandProblem('{"command":"count","collection":"a$b/c"}')).toContain("collection");
    expect(mongoCommandProblem('{"command":"dbStats"}')).toContain("path");
    expect(mongoCommandProblem("not json")).toContain("JSON");
  });

  it("parses a good command", () => {
    expect(parseMongoCommand('{"command":"serverStatus","path":"connections.current"}')).toEqual({
      ok: true,
      command: { command: "serverStatus", path: "connections.current" },
    });
  });
});

describe("a MongoDB answer becomes one number", () => {
  const db = (answer: unknown): MongoReader & { sent: Record<string, unknown>[] } => {
    const sent: Record<string, unknown>[] = [];
    return {
      sent,
      command: async (cmd) => {
        sent.push(cmd);
        return answer;
      },
      collection: () => ({ countDocuments: async () => 42 }),
    };
  };
  const cmd = (text: string) => {
    const r = parseMongoCommand(text);
    if (!r.ok) throw new Error(r.problem);
    return r.command;
  };

  it("counts documents", async () => {
    expect(await readMongo(db({}), cmd('{"command":"count","collection":"orders"}'), 1000)).toBe("42");
  });

  it("reads a number at a dotted path, including a driver Long", async () => {
    const reader = db({ connections: { current: { valueOf: () => 17 } }, objects: 9 });
    expect(
      await readMongo(reader, cmd('{"command":"serverStatus","path":"connections.current"}'), 1000),
    ).toBe("17");
    expect(reader.sent[0]).toEqual({ serverStatus: 1, maxTimeMS: 1000 });
  });

  it("says so when the path holds no number", async () => {
    await expect(
      readMongo(db({ ok: "yes" }), cmd('{"command":"dbStats","path":"ok"}'), 1000),
    ).rejects.toThrow(Unavailable);
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
      ).toContain("Only reads run");
    }
    expect(
      imageCommandProblem(JSON.stringify({ ...good, command: ["sh", "-c", "clickhouse-client"] })),
    ).toContain("not a shell");
    expect(imageCommandProblem(JSON.stringify({ ...good, image: "--privileged" }))).toContain("image");
    expect(imageCommandProblem(JSON.stringify({ ...good, extra: 1 }))).toContain("extra");
  });

  it("parses a good check", () => {
    expect(parseImageCommand(JSON.stringify({ ...good, path: "data.n" }))).toEqual({
      ok: true,
      value: { ...good, path: "data.n" },
    });
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

  it("says Docker is missing as a majhi problem", async () => {
    await expect(runImageCheck(undefined, safety, { ...good, env: {} }, 1000)).rejects.toThrow(
      ImageCheckFailed,
    );
    expect(MAJHI_DOCKER.startsWith("majhi problem: ")).toBe(true);
  });
});

describe("driver failures", () => {
  it("never carry the driver's own text; a missing driver is a majhi problem", () => {
    expect(refused(new Error("password authentication failed for user bob at 10.0.0.5")).message).toBe(
      "the database refused or did not answer",
    );
    expect(refused(Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" })).message).toMatch(
      /^majhi problem: /,
    );
  });
});

describe("why a database refused", () => {
  it("names the cause by the driver's code, never its text", () => {
    const err = (fields: Record<string, unknown>) =>
      Object.assign(new Error("password=hunter2 at 10.0.0.5"), fields);
    expect(refused(err({ code: "28P01" })).message).toBe(
      "the database refused the login: wrong user or password",
    );
    expect(refused(err({ code: "ETIMEDOUT" })).message).toContain("Trusted sources");
    expect(refused(err({ code: "ER_ACCESS_DENIED_ERROR" })).message).toContain("wrong user or password");
    expect(refused(err({ codeName: "AuthenticationFailed" })).message).toContain("wrong user or password");
    expect(refused(err({ code: "XX999" })).message).toBe(
      "the database refused or did not answer (code XX999)",
    );
    expect(refused(err({ code: "28P01" })).message).not.toContain("hunter2");
  });
});
