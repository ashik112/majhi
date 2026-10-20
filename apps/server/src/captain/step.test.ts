import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

/**
 * The owner owns all of it: in the All conversation the captain may read across workspaces. What stays apart is
 * the step: each action runs in one workspace with only that workspace's words and access.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("the captain's steps from the All conversation", () => {
  it("makes one step per workspace, and the step for Globex never carries Acme's words", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const must = async (cmd: Promise<{ status: number; body: unknown }>) => {
      const res = await cmd;
      if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    };
    await must(h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" }));
    await must(
      h.cmd("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" }),
    );
    await w.addRepo("web");
    await must(h.cmd("projects.register", { id: "globex-web", org: "globex", path: "~/Work/web" }));
    // Globex names its own account for the captain; Acme runs on the captain's.
    await must(h.cmd("authority.set", { org: "acme", level: "routine" }));
    await must(h.cmd("authority.set", { org: "globex", level: "routine" }));
    await must(h.cmd("autonomy.configure", { orgs: { globex: { account: "claude-globex" } } }));
    const services = h.majhi.services;
    const desk = w.chat.id;
    const call = (args: Record<string, unknown>) =>
      services.admin.call({ task: desk, agent: "boss" }, "majhi_captain_step", {
        reason: "the owner asked",
        ownerAsked: true,
        ...args,
      });
    const spoken = (org: string): string => {
      const chat = services.lanes.chat(org);
      if (chat === undefined) throw new Error(`no step in ${org}`);
      return services.store.room
        .page(chat, 50)
        .items.map((i) => ("text" in i ? i.text : ""))
        .join("\n");
    };

    const acme = await call({ org: "acme", ask: "Check the checkout rounding in acme-api" });
    const globex = await call({ org: "globex", ask: "Check the invoice export in globex-web" });
    expect([acme.isError, globex.isError]).toEqual([false, false]);
    expect(services.lanes.chat("acme")).not.toEqual(services.lanes.chat("globex"));
    expect(spoken("acme")).toContain("checkout rounding in acme-api");
    expect(spoken("globex")).toContain("invoice export in globex-web");
    for (const word of ["Acme", "acme", "checkout"]) expect(spoken("globex")).not.toContain(word);
    for (const word of ["Globex", "globex", "invoice"]) expect(spoken("acme")).not.toContain(word);

    // A step that carries the other workspace's words is refused and sends nothing.
    const before = spoken("globex");
    const carried = await call({ org: "globex", ask: "Do the same as Acme did in acme-api" });
    expect(carried.isError).toBe(true);
    expect(carried.text).toContain("belongs to another workspace");
    expect(spoken("globex")).toEqual(before);
  });
});
