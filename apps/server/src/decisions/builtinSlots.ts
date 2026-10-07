import type { Fact, Role, TaskKind } from "@majhi/shared";
import { reviewRequest } from "../memory/curator.ts";
import { verdictQuestion } from "../rooms/coordinator.ts";
import { mentionQuestion } from "../rooms/mentions.ts";
import { difficultyQuestion } from "../runs/difficulty.ts";
import { delegationQuestion } from "../runs/effort-check.ts";
import { type Fixture, type SlotDef, SlotRegistry } from "./slots.ts";
import { LAYA_USE_SLOTS } from "./uses/slots.ts";

// Built-in labeled examples, in generic names. They report how a provider does on typical
// cases; they never decide that a slot may act, only the owner's and the outcomes' labels do.

const task = (title: string, brief: string, kind: TaskKind, label: string): Fixture => ({
  request: difficultyQuestion({ title, brief, kind, repos: ["acme-web"], role: "Builder" as Role }),
  question: "difficulty",
  label,
});

const SIZES = (): Fixture[] => [
  task("Fix typo in README heading", "Fix typo in README heading", "code", "trivial"),
  task("Bump version to 1.4.1", "Bump the version in package.json to 1.4.1", "code", "trivial"),
  task("Add a loading state", "Add a loading state to the Acme invoice list", "code", "small"),
  task(
    "Rename retryCount",
    "Rename the retryCount option to maxRetries and update its two call sites",
    "code",
    "small",
  ),
  task(
    "CSV export for reports",
    "Add CSV export to the Globex reports page, with tests and a download button",
    "code",
    "medium",
  ),
  task(
    "Move sessions to Redis",
    "Migrate the Northwind session store to Redis with a fallback to memory and tests for both",
    "code",
    "medium",
  ),
  task(
    "Event-driven billing",
    "Redesign the Acme billing pipeline into event-driven services: a design doc, a queue, three services, a migration and a rollout plan",
    "code",
    "large",
  ),
  task(
    "Find the lost writes",
    "Hunt the intermittent data loss in the Globex sync worker across all queues and fix every cause",
    "code",
    "large",
  ),
];

const wake = (from: string, agent: string, text: string, label: string): Fixture => ({
  request: mentionQuestion(from, [agent], text),
  question: "acts_1",
  label,
});

const WAKES = (): Fixture[] => [
  wake(
    "acme-lead",
    "acme-builder",
    "@acme-builder please fix the failing checkout test and push the change",
    "true",
  ),
  wake(
    "acme-lead",
    "acme-reviewer",
    "@acme-reviewer can you review the invoice export before I merge?",
    "true",
  ),
  wake(
    "acme-builder",
    "acme-tester",
    "@acme-tester run the full suite on the new branch and report any failures",
    "true",
  ),
  wake("acme-lead", "acme-builder", "@acme-builder what is blocking the export? Answer in the room", "true"),
  wake("acme-builder", "acme-lead", "Done with the parser. @acme-lead FYI, all tests pass.", "false"),
  wake(
    "acme-builder",
    "acme-reviewer",
    "Waiting on the CI run. Nothing for @acme-reviewer to do yet.",
    "false",
  ),
  wake("acme-reviewer", "acme-builder", "Looks good to me. Thanks @acme-builder.", "false"),
  wake("acme-lead", "acme-tester", "Status: the export is merged, as @acme-tester saw earlier.", "false"),
];

const verdict = (text: string, label: string): Fixture => ({
  request: verdictQuestion("acme-reviewer", text),
  question: "verdict",
  label,
});

const VERDICTS = (): Fixture[] => [
  verdict("Reviewed the diff. Everything is correct and tested. Ship it.", "A"),
  verdict("LGTM, no further changes needed from my side.", "A"),
  verdict("The change is clean and covers the edge cases. Approved.", "A"),
  verdict("Nothing to add. The tests pass and the naming is fine.", "A"),
  verdict("The retry loop never stops on a 4xx. Please fix before merging.", "B"),
  verdict("Missing tests for the empty list case, and the migration is not reversible.", "B"),
  verdict("I have not finished reading the second half yet. Notes so far: the cache key is wrong.", "B"),
  verdict("This breaks the invoice export for orders without a tax id. Needs changes.", "B"),
];

const fact = (text: string, label: string): Fixture => ({
  // Only the fields the question reads are filled in.
  request: reviewRequest({ text, scope: "project:acme-api" } as unknown as Fact, undefined),
  question: "verdict",
  label,
});

const VERDICT_FACTS = (): Fixture[] => [
  fact("Invoices in acme-api are rounded half to even before tax is added, never after it", "keep"),
  fact("The acme-api staging deploy needs the VPN profile named acme-stg to be connected", "keep"),
  fact("Run database migrations with pnpm db:migrate before starting the acme-api server", "keep"),
  fact("Symptom: the build failed twice this afternoon with a timeout in the checkout step", "not-keep"),
  fact("Always double check your work before reporting it done", "not-keep"),
  fact("Agents in a task room are woken when another message mentions their handle", "not-keep"),
  fact("The checkout test is flaky when it starts within 200 ms of the clock tick", "not-keep"),
  fact("This task needed three tries because the first branch was stale", "not-keep"),
];

const secret = (text: string, label: string): Fixture => ({
  request: reviewRequest({ text, scope: "project:acme-api" } as unknown as Fact, undefined),
  question: "private",
  label,
});

const PRIVATE = (): Fixture[] => [
  secret("The deploy token is sk-test-4f9a8b7c6d5e and expires on Friday", "true"),
  secret("Contact Jane Doe at jane.doe@example.com or +1 555 0100 for the Globex account", "true"),
  secret("The database password for staging is hunter2-staging", "true"),
  secret("Invoices are rounded half to even before tax", "false"),
  secret("Run pnpm db:migrate before starting the server", "false"),
  secret("The staging deploy needs the acme-stg VPN profile", "false"),
];

const delegate = (id: string, description: string, label: string): Fixture => ({
  request: delegationQuestion({ id, description } as Parameters<typeof delegationQuestion>[0]),
  question: "delegates",
  label,
});

const DELEGATES = (): Fixture[] => [
  delegate("swarm", "Splits the work across several sub-agents that run in parallel", "A"),
  delegate("orchestrate", "Delegates subtasks to helper agents and merges their results", "A"),
  delegate("high", "Thinks longer before answering, for harder problems", "B"),
  delegate("low", "Answers fast with little deliberation", "B"),
  delegate("medium", "A balance of speed and depth of thought", "B"),
];

const groupKeep = (value: string): string =>
  value === "keep" ? "keep" : value === "ask" ? "ask" : "not-keep";

export const BUILTIN_SLOTS: readonly SlotDef[] = [
  {
    id: "task-size",
    title: "Task size",
    use: "task-size",
    question: /^difficulty$/,
    target: 0.9,
    fixtures: SIZES,
  },
  {
    id: "model-pick",
    title: "Model and effort pick",
    use: "model-pick",
    question: /^difficulty$/,
    target: 0.9,
    fixtures: SIZES,
  },
  {
    id: "effort-delegation",
    title: "Effort that delegates to sub-agents",
    use: "model-pick",
    question: /^delegates$/,
    target: 0.95,
    // Shadow would let a delegating effort be picked: checked by hand before, so it stays on.
    startMode: "live",
    fixtures: DELEGATES,
  },
  {
    id: "mention-wake",
    title: "Wake on a mention",
    use: "routing",
    question: /^acts_\d+$/,
    // Shadow would wake every mentioned agent, which costs more; it keeps its own bar until it is calibrated.
    startMode: "live",
    target: 0.95,
    fixtures: WAKES,
  },
  {
    id: "review-verdict",
    title: "Reviewer's verdict",
    use: "routing",
    question: /^verdict$/,
    target: 0.95,
    fixtures: VERDICTS,
  },
  { id: "team-pick", title: "Team for a new task", use: "routing", question: /^team$/, target: 0.9 },
  { id: "task-type", title: "Type of a new task", use: "routing", question: /^type$/, target: 0.9 },
  {
    id: "memory-verdict",
    title: "Keep or drop a fact",
    use: "memory",
    question: /^(verdict|worth)$/,
    // Shadow would leave every waiting fact to the owner; it keeps the old bar until it is calibrated.
    startMode: "live",
    target: 0.98,
    classOf: groupKeep,
    fixtures: VERDICT_FACTS,
  },
  {
    id: "memory-private",
    title: "Fact holds a secret or personal data",
    use: "memory",
    question: /^private$/,
    target: 0.98,
    fixtures: PRIVATE,
  },
  {
    id: "memory-relation",
    title: "Fact against the nearest fact",
    use: "memory",
    question: /^relation$/,
    // Merges and contradictions keep the old bar until calibrated, so duplicates still merge.
    startMode: "live",
    target: 0.95,
  },
  {
    id: "memory-scope",
    title: "Where a fact belongs",
    use: "memory",
    question: /^(level|project)$/,
    target: 0.9,
  },
  ...LAYA_USE_SLOTS,
];

/** The registry the decision service uses. Add a slot with `add` and it is labeled, evaluated and gated like these. */
export function builtinRegistry(): SlotRegistry {
  return new SlotRegistry(BUILTIN_SLOTS);
}
