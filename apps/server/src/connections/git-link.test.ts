import type { ConnectionView, OrgConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { GitLink } from "./git-link.ts";

function rig(orgs: Record<string, OrgConfig> = { acme: { name: "Acme" } }) {
  const views: ConnectionView[] = [];
  const checks: string[] = [];
  const started: string[] = [];
  const updates: unknown[] = [];
  const link = new GitLink({
    connections: {
      list: async () => structuredClone(views),
      create: async (input) => {
        const view = {
          id: (input as { id?: string }).id ?? "x",
          org: input.org,
          type: "git",
          name: input.name,
          description: input.description ?? "",
          fields: Object.fromEntries(
            Object.entries(input.fields).map(([k, v]) => [k, { kind: "text", set: true, value: v }]),
          ),
        } as unknown as ConnectionView;
        views.push(view);
        return view;
      },
      update: async (input) => {
        updates.push(input);
        const view = views.find((v) => v.id === input.id);
        for (const [k, v] of Object.entries(input.fields)) {
          if (view !== undefined && v !== null) view.fields[k] = { kind: "text", set: true, value: v };
        }
      },
    },
    orgs: async () => orgs,
    kindOf: (host) =>
      host.includes("github")
        ? "github"
        : host.includes("gitlab")
          ? "gitlab"
          : host.includes("bitbucket")
            ? "bitbucket"
            : undefined,
    check: async (id) => {
      await new Promise((r) => setTimeout(r, 5));
      checks.push(id);
    },
    health: { start: (id) => void started.push(id) },
  });
  return { link, views, checks, started, updates };
}

describe("a git host sign-in is a connection", () => {
  it("makes one git connection per workspace and host, named for the host, and checks it", async () => {
    const r = rig();
    const id = await r.link.signedIn({ org: "acme", kind: "github", host: "github.com" });
    expect(r.views).toHaveLength(1);
    expect(r.views[0]).toMatchObject({ id, org: "acme", type: "git", name: "GitHub" });
    expect(r.views[0]?.fields.provider?.value).toBe("github");
    expect(r.views[0]?.fields.host).toBeUndefined();
    // The state starts before the check, so the row never reads connected before a call passed.
    expect(r.started).toEqual([id]);
    expect(r.checks).toEqual([id]);
  });

  it("a self-hosted host is its own connection with the host in its name and fields", async () => {
    const r = rig();
    await r.link.signedIn({ org: "acme", kind: "gitlab", host: "gitlab.com" });
    const id = await r.link.signedIn({
      org: "acme",
      kind: "gitlab",
      host: "gitlab.acme.test",
      privateNetwork: true,
    });
    expect(r.views).toHaveLength(2);
    expect(r.views.find((v) => v.id === id)).toMatchObject({ name: "GitLab (gitlab.acme.test)" });
    expect(r.views.find((v) => v.id === id)?.fields).toMatchObject({
      host: { value: "gitlab.acme.test" },
      private_network: { value: "yes" },
    });
  });

  it("signing in again reuses the connection, and two workspaces keep their own", async () => {
    const r = rig({ acme: { name: "Acme" }, globex: { name: "Globex" } });
    const a1 = await r.link.signedIn({ org: "acme", kind: "github", host: "github.com" });
    const a2 = await r.link.signedIn({ org: "acme", kind: "github", host: "github.com" });
    const g = await r.link.signedIn({ org: "globex", kind: "github", host: "github.com" });
    expect(a2).toBe(a1);
    expect(g).not.toBe(a1);
    expect(r.views.map((v) => v.org).sort()).toEqual(["acme", "globex"]);
  });

  it("the sign-in's own hook and the command that awaits it share one check", async () => {
    const r = rig();
    const ref = { org: "acme", kind: "github" as const, host: "github.com" };
    const [one, two] = await Promise.all([r.link.signedIn(ref), r.link.signedIn(ref)]);
    expect(one).toBe(two);
    expect(r.checks).toHaveLength(1);
  });

  it("an owner who confirms a private host later marks the existing connection", async () => {
    const r = rig();
    const id = await r.link.ensure({ org: "acme", kind: "github", host: "ghe.acme.test" });
    await r.link.ensure({ org: "acme", kind: "github", host: "ghe.acme.test", privateNetwork: true });
    expect(r.views).toHaveLength(1);
    expect(r.updates).toEqual([{ id, fields: { private_network: "yes" } }]);
  });

  it("makes a connection for every account that has a token, and none for one without", async () => {
    const r = rig({
      acme: {
        name: "Acme",
        git_accounts: [
          { host: "github.com", account: "acme-dev", token: "secret:a" },
          { host: "gitlab.com", account: "acme-dev" },
        ],
      } as OrgConfig,
    });
    await r.link.syncAll();
    expect(r.views.map((v) => v.name)).toEqual(["GitHub"]);
    // Nothing is checked here: the startup pass checks what was never checked.
    expect(r.checks).toEqual([]);
  });
});
