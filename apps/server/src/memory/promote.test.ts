import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Fact } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { addFact, bullet } from "./agentsMd.ts";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("AGENTS.md editing", () => {
  it("adds the bullet under ## Facts, creates the section or the file, and never repeats a fact", () => {
    const text = "# Acme API\n\nRules.\n\n## Facts\n\n- Use pnpm\n\n## Commands\n\n- pnpm test\n";
    expect(addFact(text, "Node 22 is required")).toBe(
      "# Acme API\n\nRules.\n\n## Facts\n\n- Use pnpm\n- Node 22 is required\n\n## Commands\n\n- pnpm test\n",
    );
    // No section yet: it is added at the end, after the rest as it was.
    expect(addFact("# Acme API\n\nRules.\n", "Node 22 is required")).toBe(
      "# Acme API\n\nRules.\n\n## Facts\n\n- Node 22 is required\n",
    );
    expect(addFact("", "Node 22 is required")).toBe("# AGENTS.md\n\n## Facts\n\n- Node 22 is required\n");
    // An empty section, and one that ends the file.
    expect(addFact("## Facts\n\n## Other\n", "A")).toBe("## Facts\n\n- A\n\n## Other\n");
    expect(addFact("## Facts\n", "A")).toBe("## Facts\n\n- A\n");
    // The same fact, however it was spaced, changes nothing.
    expect(addFact(text, "Use   pnpm")).toBe(text);
    expect(bullet("  a\nb ")).toBe("- a b");
  });
});

async function world() {
  w = await taskWorld();
  const { h } = w;
  const fact = async (text: string, scope = "project:acme-api") =>
    h.majhi.services.memory.add({ text, scope, pinned: false }, { kind: "owner" });
  const promote = (id: number) => h.cmd("memory.promote", { id });
  return { h, w, fact, promote };
}

describe("memory.promote", () => {
  it("makes a task with no agent, commits the bullet in its worktree, and leaves it in review", async () => {
    const { h, w, fact, promote } = await world();
    // The repo already has an AGENTS.md with a Facts section.
    const repo = w.repo("api");
    await writeFile(join(repo, "AGENTS.md"), "# Acme API\n\n## Facts\n\n- Use pnpm\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "--quiet", "-m", "agents");
    // A new task starts from the remote's base.
    await git(repo, "push", "--quiet", "origin", "main");
    const f = await fact("Builds need Node 22");

    const res = await promote(f.id);
    expect(res.status).toBe(200);
    const { task: id, fact: promoted } = res.body as { task: string; fact: Fact };
    expect(promoted.promoted).toBe(id);
    expect(h.majhi.services.memory.get(f.id)?.promoted).toBe(id);

    const task = h.majhi.services.tasks.get(id);
    expect(task).toMatchObject({ status: "review", kind: "code" });
    expect(task.repos.map((r) => r.project)).toEqual(["acme-api"]);
    const worktree = task.repos[0]?.worktree ?? "";
    expect(await readFile(join(worktree, "AGENTS.md"), "utf8")).toBe(
      "# Acme API\n\n## Facts\n\n- Use pnpm\n- Builds need Node 22\n",
    );
    // One commit on the task branch, clean tree, no trailer, and the base branch untouched.
    const log = await git(worktree, "log", "--format=%s%n%b", "main..HEAD");
    expect(log).toContain("docs: add a fact to AGENTS.md");
    expect(log).toContain("Builds need Node 22");
    expect(log).not.toMatch(/Co-Authored-By|Generated/i);
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe("# Acme API\n\n## Facts\n\n- Use pnpm\n");
    // No agent ran, and the owner merges it through the usual card.
    expect(h.runtime.starts).toHaveLength(0);
    const merged = await h.cmd("tasks.merge", { id, done: true });
    expect(merged.status).toBe(200);
    expect(await git(repo, "show", "main:AGENTS.md")).toContain("- Builds need Node 22");
  });

  it("creates AGENTS.md when the repo has none", async () => {
    const { h, fact, promote } = await world();
    const f = await fact("Releases are cut from develop");
    const res = await promote(f.id);
    expect(res.status).toBe(200);
    const task = h.majhi.services.tasks.get((res.body as { task: string }).task);
    const worktree = task.repos[0]?.worktree ?? "";
    expect(await readFile(join(worktree, "AGENTS.md"), "utf8")).toBe(
      "# AGENTS.md\n\n## Facts\n\n- Releases are cut from develop\n",
    );
  });

  it("refuses a fact that is not active, not in a project, already promoted, or already in AGENTS.md", async () => {
    const { h, w, fact, promote } = await world();
    const memory = h.majhi.services.memory;
    const pending = await memory.propose({
      text: "Tests run in CI only",
      scope: "project:acme-api",
      task: "ACM-1",
      agent: "acme-builder",
    });
    expect((await promote(pending.id)).status).toBe(409);
    const org = await fact("The org uses trunk based development", "org:acme");
    const refused = await promote(org.id);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("project fact");
    expect((await promote(9999)).status).toBe(404);

    const once = await fact("Builds need Node 22");
    expect((await promote(once.id)).status).toBe(200);
    expect((await promote(once.id)).status).toBe(409);

    const repo = w.repo("api");
    await writeFile(join(repo, "AGENTS.md"), "## Facts\n\n- Ship on Fridays\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "--quiet", "-m", "agents");
    await git(repo, "push", "--quiet", "origin", "main");
    const known = await fact("Ship on Fridays");
    const dup = await promote(known.id);
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).toContain("already has this fact");
    // Nothing was made for the refused ones: one task from the promotion that worked.
    expect(h.majhi.services.store.tasks.list(true).length).toBe(1);
  });
});
