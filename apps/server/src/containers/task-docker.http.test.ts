import { execFile } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDocker } from "../testing/fakeDocker.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * A script in a runner calls `docker`: the shim posts to /mcp/docker with the run's token, majhi
 * runs the task's own containers. A fake docker stands in for the daemon.
 */

const run = promisify(execFile);
const SHIM = join(import.meta.dirname, "..", "..", "..", "..", "docker", "docker-shim.mjs");

let w: World | undefined;
let server: Server | undefined;
let docker: FakeDocker;
afterEach(async () => {
  server?.closeAllConnections?.();
  server?.close();
  await w?.cleanup();
  w = undefined;
  server = undefined;
});

/** What each task's run got in its environment, by task. */
async function world(): Promise<{ w: World; env: Record<string, Record<string, string>> }> {
  docker = new FakeDocker();
  w = await taskWorld({ containerDocker: docker });
  const { h } = w;
  server = serve({ fetch: h.majhi.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
  const s = server;
  await new Promise<void>((resolve) => s.once("listening", () => resolve()));
  h.majhi.services.adminTokens.mcpUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
  const env: Record<string, Record<string, string>> = {};
  h.runtime.onSession = (session, start) => {
    if (start.task !== undefined) env[start.task] = { ...start.env };
    session.script = async (turn) => {
      turn.emit({ type: "text", messageId: "m1", text: "done" });
      return "end_turn";
    };
  };
  await h.cmd("containers.images.allow", { image: "nginx:1.27-alpine" });
  for (const text of ["fix api", "fix web"]) {
    const res = await h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: true });
    expect(res.status).toBe(200);
  }
  for (let i = 0; i < 600 && Object.keys(env).length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  expect(Object.keys(env).sort()).toEqual(["ACM-1", "ACM-2"]);
  return { w, env };
}

/** The shim, as the script in the runner runs it. */
async function docker_(
  env: Record<string, string>,
  cwd: string,
  ...argv: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const out = await run("node", [SHIM, ...argv], {
      env: { PATH: process.env.PATH ?? "", ...env },
      cwd,
    });
    return { code: 0, stdout: out.stdout, stderr: out.stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("docker through majhi", () => {
  it("keeps a container to its task: another task's token cannot see or remove it", async () => {
    const { w, env } = await world();
    const one = env["ACM-1"] ?? {};
    const two = env["ACM-2"] ?? {};
    const started = await docker_(one, w.taskDir("ACM-1"), "run", "-d", "--name", "web", "nginx:1.27-alpine");
    expect(started.code).toBe(0);
    expect(docker.containers.has("majhi-acm-1-c-web")).toBe(true);
    // The same name from the other task is a different container, so nothing of ACM-1 goes.
    await docker_(two, w.taskDir("ACM-2"), "rm", "-f", "web");
    await docker_(two, w.taskDir("ACM-2"), "rm", "-f", "majhi-acm-1-c-web");
    expect(docker.containers.has("majhi-acm-1-c-web")).toBe(true);
    const listed = await docker_(two, w.taskDir("ACM-2"), "ps");
    expect(listed.stdout.trim()).toBe("");
    // The id that `run -d` printed works for its own task only.
    const id = started.stdout.trim();
    const foreign = await docker_(two, w.taskDir("ACM-2"), "rm", "-f", id);
    expect(foreign.code).toBe(125);
    expect(docker.containers.has("majhi-acm-1-c-web")).toBe(true);
    const own = await docker_(one, w.taskDir("ACM-1"), "rm", "-f", id);
    expect(own.code).toBe(0);
    expect(docker.containers.has("majhi-acm-1-c-web")).toBe(false);
  });

  it("refuses what could reach past the task and leaves nothing started", async () => {
    const { w, env } = await world();
    const one = env["ACM-1"] ?? {};
    const cwd = w.taskDir("ACM-1");
    for (const argv of [
      ["run", "--privileged", "nginx:1.27-alpine"],
      ["run", "--pid=host", "nginx:1.27-alpine"],
      ["run", "--network", "host", "nginx:1.27-alpine"],
      ["run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "nginx:1.27-alpine"],
      ["run", "-v", `${w.taskDir("ACM-2")}:/o`, "nginx:1.27-alpine"],
      ["run", "-v", "/etc:/o", "nginx:1.27-alpine"],
    ]) {
      const out = await docker_(one, cwd, ...argv);
      expect(out.code, argv.join(" ")).toBe(125);
    }
    expect(docker.taskCalls).toEqual([]);
    expect(docker.containers.size).toBe(0);
  });

  it("stops at the task's container limit", async () => {
    const { w, env } = await world();
    const cwd = w.taskDir("ACM-1");
    const one = env["ACM-1"] ?? {};
    const made: number[] = [];
    for (const name of ["a", "b", "c", "d"]) {
      made.push((await docker_(one, cwd, "run", "-d", "--name", name, "nginx:1.27-alpine")).code);
    }
    // containers.per_task is 3 by default.
    expect(made).toEqual([0, 0, 0, 125]);
  });

  it("answers 401 without the run's token, and the token ends with the run", async () => {
    const { env } = await world();
    const url = env["ACM-1"]?.MAJHI_DOCKER_URL ?? "";
    const post = (token: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ argv: ["ps"], cwd: "/tmp" }),
      });
    expect((await post("nope")).status).toBe(401);
    expect((await post(env["ACM-1"]?.MAJHI_DOCKER_TOKEN ?? "")).status).toBe(200);
    await w?.h.cmd("tasks.stop", { id: "ACM-1" });
    await w?.h.majhi.services.runs.idle();
    expect((await post(env["ACM-1"]?.MAJHI_DOCKER_TOKEN ?? "")).status).toBe(401);
  });
});
