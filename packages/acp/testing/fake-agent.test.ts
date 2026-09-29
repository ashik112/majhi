import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpAuthRequired, readSessionOptions } from "../src/acp-session.ts";
import { buildEnv } from "../src/env.ts";
import type { AccountRuntime, RuntimeOptions } from "../src/index.ts";
import { loginCommand } from "../src/login.ts";
import { cliVersion, probeAccount } from "../src/probe.ts";
import { fakeAdapter } from "./index.ts";

const base = { PATH: process.env.PATH ?? "/usr/bin" };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-fake-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function opts(tool: "claude" | "codex", fake: Parameters<typeof fakeAdapter>[1] = {}): RuntimeOptions {
  return { base, adapters: { [tool]: fakeAdapter(tool, fake) }, timeoutMs: 15_000 };
}

describe.each(["claude", "codex"] as const)("probeAccount with the fake %s adapter", (tool) => {
  it("passes every step when signed in", async () => {
    const account: AccountRuntime = { tool, home: root };
    const probe = await probeAccount(
      account,
      opts(tool, { signedIn: true, models: ["m1", "m2", "m3"], efforts: ["low", "high"] }),
    );
    expect(probe.health.ok).toBe(true);
    expect(probe.health.steps.map((s) => [s.name, s.ok])).toEqual([
      ["cli", true],
      ["auth", true],
      ["acp", true],
    ]);
    expect(probe.health.steps[0]?.detail).toContain(tool === "claude" ? "2.1.284" : "0.158.0");
    expect(probe.health.steps[2]?.detail).toBe("3 models");
    expect(probe.health.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(probe.health.checkedAt))).toBe(false);
    expect(probe.models).toMatchObject({
      models: [
        { id: "m1", name: "m1" },
        { id: "m2", name: "m2" },
        { id: "m3", name: "m3" },
      ],
      efforts: [{ id: "low" }, { id: "high" }],
      defaultModel: "m1",
      defaultEffort: "low",
    });
    if (tool === "claude") expect(probe.signedInAs).toBe("fake@example.com");
  });

  it("stops at auth when not signed in", async () => {
    const probe = await probeAccount({ tool, home: root }, opts(tool));
    expect(probe.health.ok).toBe(false);
    expect(probe.health.steps.map((s) => [s.name, s.ok])).toEqual([
      ["cli", true],
      ["auth", false],
    ]);
    expect(probe.health.steps[1]?.detail).toBe("Not signed in. Sign in from Studio > Accounts.");
    expect(probe.models).toBeUndefined();
  });

  it("fails at cli when the adapter is broken", async () => {
    const probe = await probeAccount({ tool, home: root }, opts(tool, { broken: true }));
    expect(probe.health.ok).toBe(false);
    expect(probe.health.steps).toHaveLength(1);
    expect(probe.health.steps[0]).toMatchObject({ name: "cli", ok: false });
    expect(probe.health.steps[0]?.detail).toContain("broken on purpose");
  });

  it("fails at cli when the command does not exist", async () => {
    const probe = await probeAccount(
      { tool, home: root },
      { base, adapters: { [tool]: { command: "/nonexistent/adapter", args: [] } } },
    );
    expect(probe.health.steps[0]).toMatchObject({ name: "cli", ok: false });
    expect(probe.health.steps[0]?.detail).toContain("Command not found");
  });

  it("accepts an API-key account and reads models", async () => {
    const probe = await probeAccount({ tool, home: root, apiKey: "sk-test" }, opts(tool));
    expect(probe.health.ok).toBe(true);
    expect(probe.health.steps[1]).toEqual({ name: "auth", ok: true, detail: "API key" });
    expect(probe.models?.defaultModel).toBe("fake-model-a");
    expect(probe.signedInAs).toBeUndefined();
  });

  it("reports the CLI version", async () => {
    expect(await cliVersion(tool, opts(tool))).toContain(tool === "claude" ? "Claude Code" : "codex-cli");
    await expect(cliVersion(tool, opts(tool, { broken: true }))).rejects.toThrow("broken on purpose");
  });
});

describe("fake agent over ACP without sign-in", () => {
  it("answers authRequired", async () => {
    const adapter = fakeAdapter("claude");
    const env = buildEnv({ tool: "claude", home: root }, base);
    await expect(readSessionOptions(adapter, env, 15_000)).rejects.toBeInstanceOf(AcpAuthRequired);
  });
});

describe.each(["claude", "codex"] as const)("fake %s login end to end", (tool) => {
  it("signs in through the terminal command, then the probe passes", async () => {
    const options = opts(tool);
    const account: AccountRuntime = { tool, home: join(root, "home") };
    expect((await probeAccount(account, options)).health.ok).toBe(false);

    const spec = loginCommand(account, options);
    const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    await new Promise<void>((resolve) => {
      const wait = setInterval(() => {
        if (out.includes(tool === "claude" ? "Paste code here" : "Press Enter")) {
          clearInterval(wait);
          resolve();
        }
      }, 20);
    });
    expect(out).toContain(tool === "claude" ? "https://claude.ai/" : "https://auth.openai.com/codex/device");
    child.stdin.write("fake-code\n");
    expect(await exited).toBe(0);

    const file = join(account.home, tool === "claude" ? ".credentials.json" : "auth.json");
    expect(await readFile(file, "utf8")).toContain("fake-access");
    expect((await probeAccount(account, options)).health.ok).toBe(true);
  });

  it("fails the Claude login on an empty line", async () => {
    if (tool !== "claude") return;
    const spec = loginCommand({ tool, home: root }, opts(tool));
    const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    child.stdin.write("\n");
    expect(await exited).toBe(1);
  });
});
