import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

async function withOrgs() {
  h = await harness();
  expect((await h.cmd("orgs.create", { id: "acme", name: "Acme" })).status).toBe(200);
  expect((await h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" })).status).toBe(200);
}

describe("orgs.update", () => {
  it("rejects a bad email, a bad key, a taken key and an unknown org", async () => {
    await withOrgs();
    const email = await h.cmd("orgs.update", { id: "acme", identity: { name: "A", email: "not-an-email" } });
    expect(email.status).toBe(400);
    expect((await h.cmd("orgs.update", { id: "acme", key: "lower" })).status).toBe(400);
    const taken = await h.cmd("orgs.update", { id: "acme", key: "GLX" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain("Globex");
    expect((await h.cmd("orgs.update", { id: "nope", name: "X" })).status).toBe(404);
    const listed = (await h.cmd("orgs.list")).body.find((o: { id: string }) => o.id === "acme");
    expect(listed).not.toHaveProperty("identity");
  });
});

describe("orgs.update agent attribution", () => {
  it("overrides majhi's setting for an org, and null clears the override", async () => {
    await withOrgs();
    const shown = () => h.cmd("orgs.list").then((r) => r.body.find((o: { id: string }) => o.id === "acme"));
    expect(await shown()).not.toHaveProperty("commits");
    const off = await h.cmd("orgs.update", { id: "acme", commits: { attribution: false } });
    expect(off.body.commits).toEqual({ attribution: false });
    expect((await shown()).commits).toEqual({ attribution: false });
    // The file still loads.
    expect((await h.cmd("settings.get")).status).toBe(200);
    const cleared = await h.cmd("orgs.update", { id: "acme", commits: null });
    expect(cleared.body).not.toHaveProperty("commits");
  });
});

describe("orgs.update merge policy and MR tokens", () => {
  it("sets the policy and the secret per host, shows them, and defaults to never", async () => {
    await withOrgs();
    const shown = () => h.cmd("orgs.list").then((r) => r.body.find((o: { id: string }) => o.id === "acme"));
    expect((await shown()).merge).toBe("never");

    const set = await h.cmd("orgs.update", {
      id: "acme",
      merge: "auto-if-green",
      mr_tokens: { github: "secret:gh-acme", gitlab: "secret:gl-acme" },
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      merge: "auto-if-green",
      mrTokens: { github: "secret:gh-acme", gitlab: "secret:gl-acme" },
    });

    const cleared = await h.cmd("orgs.update", { id: "acme", merge: null, mr_tokens: null });
    expect(cleared.body.merge).toBe("never");
    expect(cleared.body.mrTokens).toBeUndefined();
  });

  it("rejects an unknown policy and a token that is not a secret reference", async () => {
    await withOrgs();
    expect((await h.cmd("orgs.update", { id: "acme", merge: "always" })).status).toBe(400);
    expect((await h.cmd("orgs.update", { id: "acme", mr_tokens: { github: "ghp_abc" } })).status).toBe(400);
    expect((await h.cmd("orgs.update", { id: "acme", mr_tokens: { svn: "secret:x" } })).status).toBe(400);
  });
});
