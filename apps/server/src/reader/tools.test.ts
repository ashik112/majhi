import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraphTools } from "./tools.ts";

let root: string;

const graph = (label: string) => ({
  nodes: [
    { id: "a", label, source_file: "src/a.ts", source_location: "L3" },
    { id: "b", label: "helper()", source_file: "src/b.ts", source_location: "L1" },
  ],
  links: [{ source: "a", target: "b", relation: "calls", confidence: "EXTRACTED" }],
});

async function put(org: string, project: string, label: string): Promise<void> {
  const dir = join(root, org, project);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "graph.json"), JSON.stringify(graph(label)));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-graph-"));
  await put("acme", "api", "chargeOrder()");
  await put("globex", "billing", "secretGlobexInvoice()");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const tools = (repos: readonly string[] = ["api"]) =>
  new CodeGraphTools({
    root: async () => root,
    scope: (task) => (task === "ACM-1" ? { org: "acme", repos } : undefined),
    orgOf: async (project) => ({ api: "acme", billing: "globex" })[project],
  });

describe("code_graph", () => {
  it("answers from the task's own repo", async () => {
    const text = await tools().call("ACM-1", { action: "neighbors", name: "chargeOrder" });
    expect(text).toContain("calls helper() (src/b.ts:1)");
  });

  it("never reads another workspace's graph", async () => {
    // Not a repo of the task.
    await expect(
      tools().call("ACM-1", { action: "search", name: "invoice", project: "billing" }),
    ).rejects.toThrow("not one of this task's repos");
    // A way out of the folder is not a repo either.
    await expect(
      tools().call("ACM-1", { action: "search", name: "invoice", project: "../globex/billing" }),
    ).rejects.toThrow("not one of this task's repos");
    // A repo the task lists that belongs to another workspace is refused too.
    await expect(
      tools(["api", "billing"]).call("ACM-1", { action: "search", name: "invoice", project: "billing" }),
    ).rejects.toThrow("not one of this task's repos");
    // An unknown task has no scope at all.
    await expect(tools().call("GLX-9", { action: "search", name: "invoice" })).rejects.toThrow("not known");
  });
});
