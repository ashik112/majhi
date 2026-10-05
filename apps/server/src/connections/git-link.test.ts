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

});
