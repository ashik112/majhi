import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareHome } from "./home.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-home-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("prepareHome", () => {
  it("creates the home with mode 700 and is idempotent", async () => {
    const home = join(root, "a", "claude-1");
    await prepareHome({ tool: "claude", home });
    await prepareHome({ tool: "claude", home });
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("fixes the mode of an existing home", async () => {
    const home = join(root, "h");
    await prepareHome({ tool: "claude", home });
    await import("node:fs/promises").then((fs) => fs.chmod(home, 0o755));
    await prepareHome({ tool: "claude", home });
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("writes no config.toml for login accounts", async () => {
    const home = join(root, "c");
    await prepareHome({ tool: "codex", home });
    await expect(stat(join(home, "config.toml"))).rejects.toThrow();
  });

  it("keeps the Codex API key out of auth.json", async () => {
    const home = join(root, "c");
    const account = { tool: "codex" as const, home, apiKey: "sk-test" };
    await prepareHome(account);
    await prepareHome(account);
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(
      'cli_auth_credentials_store = "ephemeral"\n',
    );
  });

  it("keeps other config.toml lines and replaces a conflicting store setting", async () => {
    const home = join(root, "c");
    await prepareHome({ tool: "codex", home });
    await writeFile(
      join(home, "config.toml"),
      'model = "x"\ncli_auth_credentials_store = "file"\n\n[tui]\ntheme = "y"\n',
    );
    const account = { tool: "codex" as const, home, apiKey: "sk-test" };
    await prepareHome(account);
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(
      'model = "x"\ncli_auth_credentials_store = "ephemeral"\n\n[tui]\ntheme = "y"\n',
    );

    await writeFile(join(home, "config.toml"), '[tui]\ntheme = "y"\n');
    await prepareHome(account);
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(
      'cli_auth_credentials_store = "ephemeral"\n[tui]\ntheme = "y"\n',
    );
  });
});
