import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, FindingsList } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function setupFindings(): Promise<Finding[]> {
  if (w === undefined) throw new Error("no world");
  const res = await w.h.cmd("findings.list", { source: "setup" });
  return (res.body as FindingsList).findings;
}

describe("readiness gaps become findings", () => {
  it("records each missing item once in the project's workspace, and a refresh adds no duplicates", async () => {
    w = await bossWorld({ real: false });
    const repo = w.repo("api");
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "acme-api", scripts: { test: "vitest run" } }),
    );
    expect((await w.h.cmd("projects.cardRefresh", { project: "acme-api" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const first = await setupFindings();
    const ci = first.filter((f) => f.project === "acme-api" && f.title.includes("ci"));
    expect(ci).toHaveLength(1);
    expect(ci[0]?.org).toBe("acme");

    expect((await w.h.cmd("projects.cardRefresh", { project: "acme-api" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const second = await setupFindings();
    expect(second.filter((f) => f.project === "acme-api").length).toBe(
      first.filter((f) => f.project === "acme-api").length,
    );
  });
});
