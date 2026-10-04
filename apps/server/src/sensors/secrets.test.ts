import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/index.ts";
import { secretScan, secretsIn } from "./secrets.ts";
import { ctxOf, FakeUpstream, findingsOf, live, makePorts } from "./testing.ts";
import { createSensorPorts } from "./wire.ts";

/** The secret scan: a finding names the file and line, and the value goes nowhere. */

// Built at run time so this file holds no secret-shaped text itself.
const TOKEN = `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3kL6"}`;
const AWS = `AKIA${"IOSFODNN7EXAMPLQ"}`;

const dump = (db: Store): string => {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables.map((t) => JSON.stringify(db.raw.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
};

function scanner(files: Record<string, string>) {
  const f = findingsOf();
  const logs: string[] = [];
  const net = new FakeUpstream().net();
  const { ports } = makePorts({
    net,
    db: f.db,
    clock: f.clock,
    logs,
    fixtures: [
      { project: { id: "acme-api", org: "acme", base: "main", remote: undefined, stack: [] }, files },
    ],
  });
  const run = () => secretScan(ports).run(ctxOf("eng-security-sweep", f.findings, f.clock));
  return { ...f, logs, run };
}

describe("secretsIn", () => {
  it("gives kinds and line numbers, never the value", () => {
    const hits = secretsIn(
      "src/config.ts",
      `const a = 1;\n\nconst token = "${TOKEN}";\nconst other = "${TOKEN}x";\n`,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("src/config.ts");
    expect(hits[0]?.lines).toContain(3);
    expect(JSON.stringify(hits)).not.toContain(TOKEN);
  });

  it("finds nothing in plain code", () => {
    expect(secretsIn("a.ts", "export const x = 1;\n// a normal comment\n")).toEqual([]);
  });
});

describe("the secret scan", () => {
  afterEach(() => vi.restoreAllMocks());

  it("files a finding with file:line, and the value is in no finding, no database row and no log", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const t = scanner({
      "src/config.ts": `export const a = 1;\nexport const b = 2;\nconst token = "${TOKEN}";\nconst aws = "${AWS}";\n`,
      "src/clean.ts": "export const ok = true;\n",
      "pnpm-lock.yaml": `packages:\n  x@1.0.0:\n    resolution: {integrity: sha512-${"A1b2C3d4E5f6G7h8".repeat(6)}}\n`,
      "node_modules/x/index.js": `const k = "${TOKEN}";`,
    });
    const res = await t.run();
    expect(res.findings).toBeGreaterThan(0);
    const found = live(t.findings).filter((f) => f.source === "security");
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      expect(f).toMatchObject({ project: "acme-api", severity: "high" });
      expect(f.evidence.every((e) => /^src\/config\.ts:\d+$/.test(e))).toBe(true);
      expect(f.dedupeKey).toMatch(/^secret:acme-api:src\/config\.ts:/);
    }
    expect(found.flatMap((f) => f.evidence)).toContain("src/config.ts:3");
    const all =
      JSON.stringify(found) +
      dump(t.db) +
      t.logs.join("\n") +
      spies.flatMap((s) => s.mock.calls.flat()).join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(AWS);
    expect(all).not.toContain("sha512-A1b2");
  });

  it("one finding per file and kind, however many lines; a rerun refreshes it and a removed secret closes it", async () => {
    const files: Record<string, string> = { "a.ts": `const x = "${TOKEN}";\nconst y = "${TOKEN}";\n` };
    const t = scanner(files);
    await t.run();
    const one = live(t.findings).filter((f) => f.source === "security");
    expect(one).toHaveLength(1);
    expect(one[0]?.evidence).toEqual(["a.ts:1", "a.ts:2"]);
    files["a.ts"] = "const x = process.env.TOKEN;\n";
    await t.run();
    expect(live(t.findings).find((f) => f.source === "security")?.status).toBe("fixed");
  });

  it("does not rescan a checkout that did not change", async () => {
    const files: Record<string, string> = { "a.ts": "export const a = 1;\n" };
    const t = scanner(files);
    expect((await t.run()).note).toBe("1 checked");
    expect((await t.run()).note).toBe("Nothing changed since the last scan");
    files["a.ts"] = `export const a = 2;\nconst x = "${TOKEN}";\n`;
    expect((await t.run()).findings).toBeGreaterThan(0);
  });
});

describe("reading a checkout", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads tracked text files only: not untracked files, symlinks out of the repo, binaries or big files", async () => {
    const root = mkdtempSync(join(tmpdir(), "majhi-sensor-"));
    dirs.push(root);
    const outside = mkdtempSync(join(tmpdir(), "majhi-outside-"));
    dirs.push(outside);
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    run("init", "-q");
    run("config", "user.email", "owner@acme.example");
    run("config", "user.name", "Owner");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(root, "big.txt"), "x".repeat(2_000));
    writeFileSync(join(outside, "private.txt"), `token ${TOKEN}`);
    symlinkSync(join(outside, "private.txt"), join(root, "link.txt"));
    run("add", "a.ts", "src/b.ts", "bin.dat", "big.txt", "link.txt");
    run("commit", "-qm", "init");
    writeFileSync(join(root, "untracked.ts"), "export const u = 1;\n");
    // The wiring pieces this test does not use are never touched.
    const ports = createSensorPorts({
      store: new Store(":memory:"),
      projects: {} as never,
      cards: {} as never,
      tokens: {} as never,
      orgs: async () => ({}),
    });
    expect((await ports.tracked(root)).sort()).toEqual([
      "a.ts",
      "big.txt",
      "bin.dat",
      "link.txt",
      "src/b.ts",
    ]);
    expect(await ports.read(root, "a.ts", 1_000)).toBe("export const a = 1;\n");
    expect(await ports.read(root, "link.txt", 1_000)).toBeUndefined();
    expect(await ports.read(root, "bin.dat", 1_000)).toBeUndefined();
    expect(await ports.read(root, "big.txt", 1_000)).toBeUndefined();
    expect(await ports.read(root, "../x", 1_000)).toBeUndefined();
    expect(await ports.read(root, "/etc/hosts", 1_000)).toBeUndefined();
    const before = await ports.fingerprint(root);
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    expect(await ports.fingerprint(root)).not.toBe(before);
  });
});
