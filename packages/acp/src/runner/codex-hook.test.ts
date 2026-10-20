import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Codex's hook runs inside the runner image as plain Node, so it lives beside the Dockerfile.
const DOCKER_CODEX = join(import.meta.dirname, "..", "..", "..", "..", "docker", "codex");
const HOOK = join(DOCKER_CODEX, "hook.mjs");
const CALL = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls" },
});

/** Runs the hook the way Codex does: the call on stdin, majhi's address and token in the environment. */
function runHook(
  env: Record<string, string>,
  stdin = CALL,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("close", (code) => done({ code, stdout }));
    child.stdin.end(stdin);
  });
}

const denied = (stdout: string): string => {
  const out = JSON.parse(stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  return out.hookSpecificOutput.permissionDecisionReason;
};

const servers: Server[] = [];
const stop = (server: Server) =>
  new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(stop));
});

/** A majhi stand-in on a free port: `answer` is what it replies to a hook's question, or nothing at all. */
async function majhi(
  answer: ((status: (n: number) => void, body: (text: string) => void) => void) | "silent",
) {
  const seen: { auth: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => {
      body += d.toString();
    });
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body });
      if (answer === "silent") return;
      let code = 200;
      answer(
        (n) => {
          code = n;
        },
        (text) => res.writeHead(code).end(text),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/codex-hook`;
  return {
    stop: () => stop(server),
    env: { MAJHI_HOOK_URL: url, MAJHI_HOOK_TOKEN: "run-token", MAJHI_HOOK_DEADLINE_MS: "600" },
    seen,
  };
}

describe("the Codex hook script", () => {
  it("lets a call run only when majhi says allow, and sends the call and the run's token as they are", async () => {
    const m = await majhi((_, body) => body(JSON.stringify({ decision: "allow" })));
    expect(await runHook(m.env)).toEqual({ code: 0, stdout: "" });
    expect(m.seen).toEqual([{ auth: "Bearer run-token", body: CALL }]);
  });

  it("fails closed: no majhi at the address, a garbage reply, an error, no credential, no call, and an owner who has not answered", async () => {
    // A port nothing listens on.
    const down = await majhi("silent");
    await down.stop();

    const garbage = await majhi((_, body) => body("<html>not json</html>"));
    const unknown = await majhi((_, body) => body(JSON.stringify({ decision: "maybe" })));
    const broken = await majhi((status, body) => {
      status(500);
      body(JSON.stringify({ decision: "allow" }));
    });
    const silent = await majhi("silent");

    const runs = {
      down: await runHook(down.env),
      garbage: await runHook(garbage.env),
      unknown: await runHook(unknown.env),
      broken: await runHook(broken.env),
      noCredential: await runHook({}),
      noCall: await runHook(silent.env, ""),
      deadline: await runHook(silent.env),
    };
    for (const [name, run] of Object.entries(runs)) {
      expect(run.code, name).toBe(0);
      expect(run.stdout, name).not.toBe("");
      denied(run.stdout);
    }
    expect(denied(runs.deadline.stdout)).toBe("Waiting for the owner's answer in majhi.");
  });

  it("gives up before Codex does: its deadline is shorter than the hook's timeout in requirements.toml", () => {
    const source = readFileSync(HOOK, "utf8");
    const line = source.split("\n").find((l) => l.startsWith("const DEADLINE_MS = "));
    const deadlineMs = Number(
      (line ?? "").slice("const DEADLINE_MS = ".length).replace(";", "").replaceAll("_", ""),
    );
    const toml = readFileSync(join(DOCKER_CODEX, "requirements.toml"), "utf8");
    const timeout = toml.split("\n").find((l) => l.startsWith("timeout = "));
    const timeoutMs = Number((timeout ?? "").slice("timeout = ".length)) * 1000;
    expect(deadlineMs).toBeGreaterThan(0);
    expect(deadlineMs).toBeLessThan(timeoutMs - 10_000);
  });
});
