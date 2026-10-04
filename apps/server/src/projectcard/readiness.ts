import type { Readiness, ReadinessItem } from "@majhi/shared";
import type { ScanFacts } from "./scanner.ts";

/**
 * How ready a repo is for agents to work in (inspired by agent-readiness scoring). Five items count,
 * one point each. A known base branch is the gate: without one nothing can be merged, so the score is 0.
 * Pure. The test command is found, not run: running a repo's code is the checks' job, not the scan's.
 */
export function readiness(facts: ScanFacts, base: string | undefined): Readiness {
  const { commands } = facts;
  const items: ReadinessItem[] = [
    {
      id: "base",
      label: "Known base branch",
      ok: base !== undefined && base !== "",
      detail: base ? `Merges go into ${base}.` : "No base branch is set or found.",
      fix: "Set the project's base branch on the Projects page.",
    },
    {
      id: "test",
      label: "Test command",
      ok: commands.test !== undefined,
      detail: commands.test
        ? `\`${commands.test}\``
        : "No test command found in the manifests, Makefile or CI.",
      fix: "Add a test script (and one smoke test) so agents can check their work.",
    },
    {
      id: "checks",
      label: "Lint or typecheck",
      ok: commands.lint !== undefined || commands.typecheck !== undefined,
      detail:
        [commands.lint, commands.typecheck]
          .filter((c) => c !== undefined)
          .map((c) => `\`${c}\``)
          .join(", ") || "No lint or typecheck command found.",
      fix: "Add a lint or typecheck script so agents catch mistakes before review.",
    },
    {
      id: "ci",
      label: "CI",
      ok: facts.ci.provider !== undefined,
      detail: facts.ci.provider
        ? `${facts.ci.provider}, ${facts.ci.workflows.length} workflow file(s).`
        : "No CI config found.",
      fix: "Add a CI workflow that runs the test and lint commands on each push.",
    },
    {
      id: "docs",
      label: "Agent docs",
      ok: facts.agentDocs,
      detail: facts.agentDocs ? "CLAUDE.md or AGENTS.md is present." : "No CLAUDE.md or AGENTS.md.",
      fix: "Write an AGENTS.md with the run, test and lint commands and the repo's rules.",
    },
    {
      id: "worktree",
      label: "Builds in a fresh worktree",
      ok: facts.lockfile && facts.setupSteps.length === 0,
      detail: !facts.lockfile
        ? "No lockfile, so a fresh checkout may install other versions."
        : facts.setupSteps.length > 0
          ? `A fresh worktree needs ${facts.setupSteps.join(" and ")} by hand.`
          : "A lockfile pins versions and no manual setup was found.",
      fix: facts.lockfile
        ? "Make setup automatic: document the steps in the install script so a new worktree needs none."
        : "Commit a lockfile so every worktree installs the same versions.",
    },
  ];
  const scored = items.filter((i) => i.id !== "base");
  const gate = items[0]?.ok === true;
  return { score: gate ? scored.filter((i) => i.ok).length : 0, max: 5, items };
}

/** The items that are missing, each with the task that would fix it. */
export function gaps(r: Readiness): ReadinessItem[] {
  return r.items.filter((i) => !i.ok);
}
