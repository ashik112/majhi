import { describe, expect, it } from "vitest";
import { ciChecks } from "./jobs.ts";
import { readCiFiles } from "./read.ts";
import { safeLine } from "./safe.ts";

const none = async () => undefined;

/** A repo's files in memory, as the CI reader sees them. */
function repo(files: Record<string, string>) {
  return {
    read: async (rel: string) => files[rel],
    list: async (rel: string) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${rel}/`) && !p.slice(rel.length + 1).includes("/"))
        .map((p) => ({ name: p.slice(rel.length + 1), dir: false })),
  };
}

describe("a check never writes", () => {
  it("runs eslint without --fix, and keeps the other flags", async () => {
    const out = await safeLine("eslint --fix --max-warnings 0 src", none);
    expect(out).toEqual({
      ok: true,
      command: "eslint --max-warnings 0 src",
      notes: ["eslint ran read-only"],
    });
  });

  it("runs the tool of a package script that fixes, read-only, through the package manager", async () => {
    const out = await safeLine("pnpm lint", async (name) => (name === "lint" ? "eslint . --fix" : undefined));
    expect(out).toEqual({
      ok: true,
      command: "pnpm exec eslint .",
      notes: ["the lint script ran read-only"],
    });
  });

  it("changes --write to --check for prettier and -w to -l for gofmt", async () => {
    expect(await safeLine("npx prettier --write .", none)).toMatchObject({
      command: "npx prettier . --check",
    });
    expect(await safeLine("gofmt -w ./...", none)).toMatchObject({ command: "gofmt -l ./..." });
    expect(await safeLine("ruff format .", none)).toMatchObject({ command: "ruff format . --check" });
  });

  it("skips a line it cannot make read-only, with the reason", async () => {
    const out = await safeLine("pnpm lint", async () => "cd src && eslint --fix .");
    expect(out).toMatchObject({ ok: false });
    expect(await safeLine("yapf -i app.py", none)).toMatchObject({ ok: false });
  });

  it("leaves a line that already only reads exactly as written", async () => {
    expect(await safeLine("pnpm exec tsc --noEmit && eslint .", none)).toEqual({
      ok: true,
      command: "pnpm exec tsc --noEmit && eslint .",
      notes: [],
    });
  });

  it("does not take a quoted word for a flag", async () => {
    const out = await safeLine("echo '--fix' && eslint .", none);
    expect(out).toMatchObject({ ok: true, notes: [] });
  });
});

describe("checks from a repo's own CI", () => {
  it("takes the command, the environment and the folder of the job that runs each check", async () => {
    const files = repo({
      ".github/workflows/ci.yml": `
name: ci
env:
  NODE_OPTIONS: --max-old-space-size=6144
jobs:
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm lint --fix
        working-directory: web
        env:
          TOKEN: \${{ secrets.TOKEN }}
          CI: "true"
      - run: |
          pnpm test
          pnpm build
  deploy:
    steps:
      - run: pnpm build
`,
    });
    const checks = ciChecks(await readCiFiles(files));
    expect(checks.map((c) => [c.kind, c.command, c.workdir])).toEqual([
      ["lint", "pnpm lint --fix", "web"],
      ["test", "pnpm test", undefined],
      ["build", "pnpm build", undefined],
    ]);
    expect(checks[0]?.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=6144", CI: "true" });
    expect(checks[0]?.from).toBe("from .github/workflows/ci.yml job quality");
    expect(checks[0]?.minutes).toBe(25);
  });

  it("reads GitLab jobs, their variables and the folder a cd moves to", async () => {
    const files = repo({
      ".gitlab-ci.yml": `
variables:
  NODE_OPTIONS: --max-old-space-size=4096
build:
  variables:
    API_PASSWORD: hunter2
  script:
    - cd app && yarn build
`,
    });
    const [build] = ciChecks(await readCiFiles(files));
    expect(build).toMatchObject({
      kind: "build",
      command: "yarn build",
      workdir: "app",
      env: { NODE_OPTIONS: "--max-old-space-size=4096" },
      from: "from .gitlab-ci.yml job build",
    });
  });
});
