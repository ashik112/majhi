import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommitShaSchema } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FactsReader } from "../../reader/run.ts";
import { extractFacts } from "./extract.ts";

const SHA = CommitShaSchema.parse("a".repeat(40));

let root: string;
let exportDir: string;
let cacheDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-wiki-facts-"));
  exportDir = join(root, "export");
  cacheDir = join(root, "cache");
  await mkdir(exportDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function put(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(exportDir, path)), { recursive: true });
    await writeFile(join(exportDir, path), text);
  }
}

/** A reader that returns what the sealed reader would have written, so no container is needed. */
const readerWith = (reader: {
  routes?: unknown[];
  entries?: unknown[];
  calls?: unknown[];
  requests?: unknown[];
}): FactsReader => ({
  async readFacts(_export, cache) {
    const out = { v: 1, files: 3, routes: [], entries: [], calls: [], errors: [], ...reader };
    await writeFile(join(cache, "reader.json"), JSON.stringify(out));
    return { ok: true, ms: 1 };
  },
});

const input = () => ({
  org: "acme",
  project: "acme-api",
  exportDir: join(root, "export"),
  cacheDir,
  sha: SHA,
});

describe("facts stay inside the export", () => {
  it("cites no path that leaves it: dot dots, absolute paths and a symlink out", async () => {
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "secret.py"), "x = 1\n");
    await put({ "app/main.py": "def health():\n    return 1\n" });
    await symlink(join(root, "outside", "secret.py"), join(exportDir, "app", "linked.py"));
    const route = (file: string, path: string) => ({
      method: "GET",
      path,
      file,
      line: 1,
      protocol: "http",
      techs: ["python_fastapi"],
    });
    const { file, report } = await extractFacts(
      input(),
      readerWith({
        routes: [
          route("app/main.py", "/ok"),
          route("../outside/secret.py", "/up"),
          route("/etc/passwd", "/absolute"),
          route("app/linked.py", "/linked"),
          route("app/missing.py", "/missing"),
        ],
      }),
    );
    expect(file.facts.map((f) => f.id)).toEqual(["acme-api:entry:http-GET-/ok@app/main.py:1"]);
    expect(file.facts.flatMap((f) => f.sources.map((s) => s.path))).toEqual(["app/main.py"]);
    // Two rows were refused as paths, two cited nothing readable.
    expect(report.errors).toEqual(["2 route rows did not fit and were left out"]);
    expect(report.dropped["no-source"]).toBe(2);
  });
});

describe("values never reach the facts", () => {
  it("keeps the names of settings and drops every value, password and key", async () => {
    await put({
      "docker-compose.yml": [
        "services:",
        "  api:",
        "    build: .",
        "    environment:",
        "      DATABASE_URL: postgres://acme:secretpw@db:5432/orders",
        "      STRIPE_SECRET_KEY: sk_test_abc",
        "      PARTS_URL: http://user:pw123@api.partsco.test:8443/v1?token=tok_live_9",
        "  db:",
        "    image: postgres:16",
        "",
      ].join("\n"),
      ".env.example":
        "BILLING_URL=https://billing.globex.test/v2?key=k_live_77\nSESSION_SECRET=hunter2hunter2\n",
    });
    const { file } = await extractFacts(input(), readerWith({}));
    const text = await readFile(join(cacheDir, "facts.json"), "utf8");
    for (const secret of ["secretpw", "sk_test_abc", "pw123", "tok_live_9", "k_live_77", "hunter2hunter2"]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(file)));
    const endpoints = file.facts.flatMap((f) =>
      f.kind === "endpoint" ? [{ host: f.host, keys: f.keys }] : [],
    );
    expect(endpoints).toEqual([
      { host: "api.partsco.test", keys: ["PARTS_URL"] },
      { host: "billing.globex.test", keys: ["BILLING_URL"] },
    ]);
    expect(file.facts.filter((f) => f.kind === "store").map((f) => f.id)).toEqual([
      "acme-api:store:postgres-db",
    ]);
  });
});

describe("calls carry a method and a path only", () => {
  it("keeps no header, body or token, and drops a path that holds one", async () => {
    await put({ "src/api.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n" });
    const row = (line: number, path: string, extra: Record<string, unknown> = {}) => ({
      file: "src/api.ts",
      line,
      method: "POST",
      path,
      ...extra,
    });
    const { file } = await extractFacts(
      input(),
      readerWith({
        requests: [
          row(1, "/api/v1/login", {
            headers: { Authorization: "Bearer sk_live_headervalue" },
            body: { password: "hunter2hunter2" },
            query: "token=tok_live_9",
          }),
          row(2, "/hooks/9fK2xQ7mLp0aZ4vB8nR1cT6yW3uE5s"),
          row(3, "/api/v1/items/{}", { host: "Api.Acme.Test", port: 8443 }),
        ],
      }),
    );
    const calls = file.facts.flatMap((f) =>
      f.kind === "call" ? [{ method: f.method, path: f.path, host: f.host, port: f.port }] : [],
    );
    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/items/{}", host: "api.acme.test", port: 8443 },
      { method: "POST", path: "/api/v1/login", host: undefined, port: undefined },
    ]);
    const text = await readFile(join(cacheDir, "facts.json"), "utf8");
    for (const secret of ["headervalue", "hunter2hunter2", "tok_live_9", "9fK2xQ7mLp0aZ4vB8nR1cT6yW3uE5s"]) {
      expect(text).not.toContain(secret);
    }
  });
});
