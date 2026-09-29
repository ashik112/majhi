import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  it("changes fields, returns the view and commits once", async () => {
    await withOrgs();
    const before = (await h.log()).length;
    const res = await h.cmd("orgs.update", {
      id: "acme",
      name: "Acme Corp",
      color: "#8ab8f5",
      base: "develop",
      key: "ACME",
      identity: { name: "Ashik", email: "ashik@acme.example" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: "acme",
      name: "Acme Corp",
      color: "#8ab8f5",
      base: "develop",
      key: "ACME",
      identity: { name: "Ashik", email: "ashik@acme.example" },
      accountCount: 0,
      agentCount: 0,
    });
    expect((await h.log()).length).toBe(before + 1);
    expect((await h.log())[0]).toContain("orgs.update");
    const yaml = await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8");
    expect(yaml).toContain("ashik@acme.example");
    const listed = (await h.cmd("orgs.list")).body.find((o: { id: string }) => o.id === "acme");
    expect(listed.identity.email).toBe("ashik@acme.example");
  });

  it("leaves fields it was not given alone, and null clears an optional one", async () => {
    await withOrgs();
    await h.cmd("orgs.update", { id: "acme", base: "develop", identity: { name: "A", email: "a@b.co" } });
    const kept = await h.cmd("orgs.update", { id: "acme", name: "Acme 2" });
    expect(kept.body).toMatchObject({
      name: "Acme 2",
      base: "develop",
      identity: { name: "A", email: "a@b.co" },
    });
    const cleared = await h.cmd("orgs.update", { id: "acme", base: null, identity: null });
    expect(cleared.body.base).toBeUndefined();
    expect(cleared.body.identity).toBeUndefined();
    expect(cleared.body.key).toBe("ACM");
  });

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
