import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

const HOSTS: Record<string, string> = {
  "acme-api": "gitlab.com",
  "acme-web": "github.com",
  "acme-docs": "git.example.com",
  "globex-app": "gitlab.com",
};

describe("moving a project's SSH alias to the workspace git account", () => {
  it("sets the route of an account that has none, never overwrites one that is set, leaves an alias with no account, drops the old keys, and runs once", async () => {
    h = await harness({ workspaces: false });
    const file = join(h.env.majhiHome, "majhi.yaml");
    await writeFile(
      file,
      [
        "workspaces: [~/Work]",
        "orgs:",
        "  acme:",
        "    name: Acme",
        "    git_accounts:",
        "      - { host: gitlab.com, account: acme-dev }",
        "      - { host: github.com, account: acme-gh, ssh: gh-acme }",
        "  globex: { name: Globex }",
        "projects:",
        "  acme-api:",
        "    { org: acme, path: ~/Work/api, remotes: { origin: { host: gitlab, ssh: gl-acme, mr: true } } }",
        "  acme-web:",
        "    { org: acme, path: ~/Work/web, remotes: { origin: { host: github, ssh: gh-other } } }",
        "  acme-docs:",
        "    { org: acme, path: ~/Work/docs, remotes: { origin: { ssh: docs-alias } } }",
        "  globex-app:",
        "    { org: globex, path: ~/Work/app, remotes: { origin: { ssh: gl-globex } } }",
        "",
      ].join("\n"),
    );
    const service = h.majhi.services.config;
    const hostOf = async (r: { project: string }) => HOSTS[r.project];
    const result = await service.migrateRemoteRoutes(hostOf);

    const { orgs, projects } = await service.sections();
    // acme's gitlab.com account had no route, so it takes the alias.
    expect(orgs.acme?.git_accounts?.[0]).toMatchObject({ host: "gitlab.com", ssh: "gl-acme" });
    // acme's github.com account already routes via gh-acme: the other project's alias does not replace it.
    expect(orgs.acme?.git_accounts?.[1]).toMatchObject({ host: "github.com", ssh: "gh-acme" });
    // No account for the host: nothing moves, and the migration says so.
    expect(result?.moved).toHaveLength(1);
    expect(result?.left).toHaveLength(3);
    expect(result?.summary).toContain(
      "acme-docs origin (docs-alias): acme has no git account for git.example.com",
    );
    expect(orgs.globex?.git_accounts).toBeUndefined();

    // The old keys are gone; what else the remote says stays, and an emptied entry goes.
    const yaml = await readFile(file, "utf8");
    expect(yaml).not.toContain("docs-alias");
    expect(yaml).not.toContain("gh-other");
    expect(projects["acme-api"]?.remotes).toEqual({ origin: { mr: true } });
    expect(projects["acme-web"]?.remotes).toBeUndefined();
    expect(projects["acme-docs"]?.remotes).toBeUndefined();

    expect(await service.migrateRemoteRoutes(hostOf)).toBeUndefined();
  });
});
