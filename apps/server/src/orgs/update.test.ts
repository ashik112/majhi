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
