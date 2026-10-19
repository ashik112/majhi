import { describe, expect, it } from "vitest";
import { safeLine } from "./safe.ts";

const none = async () => undefined;

describe("a check never writes", () => {
  it("runs eslint without --fix, and keeps the other flags", async () => {
    const out = await safeLine("eslint --fix --max-warnings 0 src", none);
    expect(out).toEqual({
      ok: true,
      command: "eslint --max-warnings 0 src",
      notes: ["eslint ran read-only"],
    });
  });

  it("never passes --fix through to a package script as an extra argument", async () => {
    const out = await safeLine("pnpm lint --fix", async (name) => (name === "lint" ? "eslint ." : undefined));
    expect(out.ok).toBe(true);
    expect(out.ok && out.command.includes("--fix")).toBe(false);
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
