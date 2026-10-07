import type { WikiDeployJob, WikiDeploySystem } from "@majhi/shared";
import { z } from "zod";
import type { ScanContext } from "./context.ts";
import type { GitlabFile, YamlFile } from "./deploy-files.ts";
import { baseOf } from "./read.ts";
import type { Cite } from "./sink.ts";

/**
 * CI workflows and pipelines: GitHub Actions, GitLab CI (the root file and its local includes) and Bitbucket
 * Pipelines. Each file is one `deploy` fact: what starts it (a manual run and its inputs, a push to a branch, a tag,
 * a schedule, another workflow), its jobs with what they need and where they deploy, and its locks. Names only: no
 * command, no value, no secret.
 */

/** The most cites a fact keeps; the contract allows 12. */
const CITES_MAX = 12;

/** A text on one line, cut to `max` characters. */
export function clip(text: string, max: number): string {
  const flat = text.split("\n").join(" ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const Str = z.string();
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const stringOrList = (value: unknown): string[] => (typeof value === "string" ? [value] : strings(value));
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A fact with every default filled in, for a scanner to add. */
export interface DeployDraft {
  system: WikiDeploySystem;
  name: string;
  slug: string;
  cites: Cite[];
  triggers?: string[];
  inputs?: string[];
  jobs?: WikiDeployJob[];
  guards?: string[];
  note?: string | undefined;
}

export function addDeploy(ctx: ScanContext, d: DeployDraft): void {
  ctx.sink.add({
    kind: "deploy",
    system: d.system,
    name: clip(d.name, 160),
    triggers: (d.triggers ?? []).slice(0, 12).map((t) => clip(t, 160)),
    inputs: [...new Set(d.inputs ?? [])].slice(0, 20).map((t) => clip(t, 80)),
    jobs: (d.jobs ?? []).slice(0, 30),
    guards: (d.guards ?? []).slice(0, 10).map((t) => clip(t, 160)),
    ...(d.note === undefined || d.note === "" ? {} : { note: clip(d.note, 300) }),
    basis: "declared",
    slug: d.slug,
    cites: d.cites.slice(0, CITES_MAX),
  });
}

const job = (j: Partial<WikiDeployJob> & { name: string }): WikiDeployJob => ({
  name: clip(j.name, 80),
  ...(j.stage === undefined ? {} : { stage: clip(j.stage, 60) }),
  needs: (j.needs ?? []).slice(0, 8).map((n) => clip(n, 80)),
  ...(j.environment === undefined ? {} : { environment: clip(j.environment, 80) }),
  manual: j.manual ?? false,
  ...(j.rule === undefined ? {} : { rule: clip(j.rule, 160) }),
  inputs: (j.inputs ?? []).slice(0, 12).map((n) => clip(n, 80)),
});

// GitHub Actions ----------------------------------------------------------------------------------

const GhJob = z.looseObject({
  needs: z
    .union([Str, z.array(Str)])
    .optional()
    .catch(undefined),
  environment: z
    .union([Str, z.looseObject({ name: Str.optional().catch(undefined) })])
    .optional()
    .catch(undefined),
  if: z.union([Str, z.boolean()]).optional().catch(undefined),
  uses: Str.optional().catch(undefined),
  concurrency: z
    .union([Str, z.looseObject({ group: Str.optional().catch(undefined) })])
    .optional()
    .catch(undefined),
});

const Workflow = z.looseObject({
  name: Str.optional().catch(undefined),
  on: z.unknown().optional(),
  concurrency: z
    .union([Str, z.looseObject({ group: Str.optional().catch(undefined) })])
    .optional()
    .catch(undefined),
  jobs: z.record(Str, z.unknown()).optional().catch(undefined),
});

/** What starts a workflow, from its `on:` block in any of its three forms (a name, a list, a map). */
export function workflowTriggers(on: unknown): { triggers: string[]; inputs: string[] } {
  const triggers: string[] = [];
  const inputs: string[] = [];
  if (typeof on === "string" || Array.isArray(on)) {
    for (const event of stringOrList(on)) triggers.push(event === "workflow_dispatch" ? "manual" : event);
    return { triggers, inputs };
  }
  for (const [event, raw] of Object.entries(record(on))) {
    const cfg = record(raw);
    const listed = (key: string) => stringOrList(cfg[key]).join(", ");
    switch (event) {
      case "push": {
        const branches = listed("branches");
        const tags = listed("tags");
        if (branches !== "") triggers.push(`push to ${branches}`);
        if (tags !== "") triggers.push(`push of tags ${tags}`);
        if (branches === "" && tags === "") triggers.push("push");
        break;
      }
      case "pull_request":
      case "pull_request_target": {
        const branches = listed("branches");
        triggers.push(branches === "" ? "pull request" : `pull request to ${branches}`);
        break;
      }
      case "workflow_dispatch":
        triggers.push("manual");
        inputs.push(...Object.keys(record(cfg.inputs)));
        break;
      case "workflow_call":
        triggers.push("called by another workflow");
        inputs.push(...Object.keys(record(cfg.inputs)));
        break;
      case "schedule":
        for (const item of Array.isArray(raw) ? raw : []) {
          const cron = record(item).cron;
          if (typeof cron === "string") triggers.push(`schedule ${cron}`);
        }
        break;
      case "workflow_run":
        triggers.push(`after workflow ${listed("workflows") || "another"}`);
        break;
      case "release":
      case "repository_dispatch":
      case "registry_package": {
        const types = listed("types");
        triggers.push(types === "" ? event : `${event} ${types}`);
        break;
      }
      default:
        triggers.push(event);
    }
  }
  return { triggers, inputs };
}

function scanWorkflow(ctx: ScanContext, file: YamlFile): void {
  const wf = Workflow.safeParse(file.located.data);
  if (!wf.success) return;
  const at = (path: (string | number)[]): Cite => {
    const line = file.located.lineOf(path) ?? 1;
    return { path: file.path, lines: [line, line] };
  };
  const { triggers, inputs } = workflowTriggers(wf.data.on);
  const guards: string[] = [];
  const lock = (c: unknown, where: string) => {
    const group = typeof c === "string" ? c : record(c).group;
    if (typeof group === "string") guards.push(`lock: concurrency group ${group}${where}`);
  };
  lock(wf.data.concurrency, "");
  const jobs: WikiDeployJob[] = [];
  const cites: Cite[] = [at(["on"])];
  const reusable: string[] = [];
  for (const [id, raw] of Object.entries(wf.data.jobs ?? {})) {
    const parsed = GhJob.safeParse(raw);
    const j = parsed.success ? parsed.data : {};
    const environment = typeof j.environment === "string" ? j.environment : j.environment?.name;
    jobs.push(
      job({
        name: id,
        needs: stringOrList(j.needs),
        ...(environment === undefined ? {} : { environment }),
        ...(typeof j.if === "string" ? { rule: j.if } : {}),
      }),
    );
    lock(j.concurrency, ` (job ${id})`);
    if (j.uses !== undefined) reusable.push(`${id} calls ${j.uses}`);
    cites.push(at(["jobs", id]));
  }
  addDeploy(ctx, {
    system: "github-actions",
    name: wf.data.name ?? baseOf(file.path),
    slug: `github-actions:${file.path}`,
    cites,
    triggers,
    inputs,
    jobs,
    guards,
    note: reusable.length === 0 ? undefined : `reusable workflows: ${reusable.join("; ")}`,
  });
}

// GitLab CI ---------------------------------------------------------------------------------------

/** Top-level keys of a GitLab file that are settings, not jobs. */
const GITLAB_SETTINGS: ReadonlySet<string> = new Set([
  "stages",
  "variables",
  "default",
  "include",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
  "spec",
]);

function gitlabRule(j: Record<string, unknown>): string | undefined {
  const rules = Array.isArray(j.rules) ? j.rules.map(record) : [];
  const conditions = rules.flatMap((r) => (typeof r.if === "string" ? [r.if] : []));
  if (conditions.length > 0) return conditions.slice(0, 2).join(" | ");
  const only = j.only;
  const refs = Array.isArray(only) ? strings(only) : strings(record(only).refs);
  return refs.length === 0 ? undefined : `only ${refs.join(", ")}`;
}

function scanGitlabFile(ctx: ScanContext, file: GitlabFile): void {
  const root = record(file.located.data);
  const at = (path: (string | number)[]): Cite => {
    const line = file.located.lineOf(path) ?? 1;
    return { path: file.path, lines: [line, line] };
  };
  const jobs: WikiDeployJob[] = [];
  const inputs: string[] = [];
  const guards: string[] = [];
  const notes: string[] = [];
  const cites: Cite[] = [];
  for (const [id, raw] of Object.entries(root)) {
    if (id.startsWith(".") || GITLAB_SETTINGS.has(id)) continue;
    const j = record(raw);
    if (!("script" in j) && !("trigger" in j) && !("extends" in j) && !("run" in j)) continue;
    const rules = Array.isArray(j.rules) ? j.rules.map(record) : [];
    const manual = j.when === "manual" || rules.some((r) => r.when === "manual");
    const environment = typeof j.environment === "string" ? j.environment : record(j.environment).name;
    const needs = (Array.isArray(j.needs) ? j.needs : []).flatMap((n) => {
      const named = typeof n === "string" ? n : record(n).job;
      return typeof named === "string" ? [named] : [];
    });
    const variables = manual ? Object.keys(record(j.variables)) : [];
    inputs.push(...variables);
    const resource = j.resource_group;
    if (typeof resource === "string") guards.push(`lock: resource group ${resource} (job ${id})`);
    const trigger = j.trigger;
    const downstream = typeof trigger === "string" ? trigger : record(trigger).project;
    if (typeof downstream === "string") notes.push(`${id} starts a pipeline of ${downstream}`);
    const rule = gitlabRule(j);
    jobs.push(
      job({
        name: id,
        ...(typeof j.stage === "string" ? { stage: j.stage } : {}),
        needs,
        ...(typeof environment === "string" ? { environment } : {}),
        manual,
        ...(rule === undefined ? {} : { rule }),
        inputs: variables,
      }),
    );
    cites.push(at([id]));
  }
  if (jobs.length === 0 && file.unread.length === 0) return;
  const pipeline = record(root.workflow);
  const triggers = (Array.isArray(pipeline.rules) ? pipeline.rules.map(record) : [])
    .flatMap((r) => (typeof r.if === "string" ? [`pipeline when ${r.if}`] : []))
    .slice(0, 3);
  if (file.unread.length > 0) notes.push(`includes not read here: ${file.unread.join("; ")}`);
  addDeploy(ctx, {
    system: "gitlab-ci",
    name: file.path,
    slug: `gitlab-ci:${file.path}`,
    cites: cites.length === 0 ? [{ path: file.path, lines: [1, 1] }] : cites,
    triggers,
    inputs,
    jobs,
    guards,
    note: notes.join("; "),
  });
}

// Bitbucket Pipelines -----------------------------------------------------------------------------

interface BitbucketStep {
  name: string | undefined;
  deployment: string | undefined;
  manual: boolean;
}

/** The steps inside a list of pipeline entries: a step, a parallel group of steps, or a stage of steps. */
function bitbucketSteps(entries: unknown): BitbucketStep[] {
  const out: BitbucketStep[] = [];
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    const e = record(entry);
    if ("step" in e) {
      const step = record(e.step);
      out.push({
        name: typeof step.name === "string" ? step.name : undefined,
        deployment: typeof step.deployment === "string" ? step.deployment : undefined,
        manual: step.trigger === "manual",
      });
    }
    const group = record(e.parallel);
    const inner = Array.isArray(e.parallel) ? e.parallel : group.steps;
    if (inner !== undefined) out.push(...bitbucketSteps(inner));
    if ("stage" in e) out.push(...bitbucketSteps(record(e.stage).steps));
  }
  return out;
}

function scanBitbucket(ctx: ScanContext, file: YamlFile): void {
  const pipelines = record(record(file.located.data).pipelines);
  const at = (path: (string | number)[]): Cite => {
    const line = file.located.lineOf(path) ?? 1;
    return { path: file.path, lines: [line, line] };
  };
  const jobs: WikiDeployJob[] = [];
  const triggers: string[] = [];
  const inputs: string[] = [];
  const cites: Cite[] = [];
  const group = (path: string[], label: string, trigger: string, entries: unknown) => {
    triggers.push(trigger);
    cites.push(at(["pipelines", ...path]));
    const list = Array.isArray(entries) ? entries : [];
    // A manual pipeline starts with its variables: the names a person fills in.
    for (const entry of list) {
      const variables = record(entry).variables;
      for (const v of Array.isArray(variables) ? variables : []) {
        const name = record(v).name;
        if (typeof name === "string") inputs.push(name);
      }
    }
    for (const [i, s] of bitbucketSteps(list).entries()) {
      jobs.push(
        job({
          name: s.name ?? `step ${i + 1} of ${label}`,
          ...(s.deployment === undefined ? {} : { environment: s.deployment }),
          manual: s.manual,
          rule: label,
        }),
      );
    }
  };
  if (pipelines.default !== undefined)
    group(["default"], "default", "every push (default pipeline)", pipelines.default);
  for (const [kind, label] of [
    ["branches", "branch"],
    ["tags", "tag"],
    ["bookmarks", "bookmark"],
  ] as const) {
    for (const [pattern, entries] of Object.entries(record(pipelines[kind]))) {
      group([kind, pattern], `${label} ${pattern}`, `push to ${label} ${pattern}`, entries);
    }
  }
  if (pipelines["pull-requests"] !== undefined) {
    group(
      ["pull-requests"],
      "pull requests",
      "pull requests",
      Object.values(record(pipelines["pull-requests"])).flat(),
    );
  }
  for (const [name, entries] of Object.entries(record(pipelines.custom))) {
    group(["custom", name], `custom ${name}`, `manual pipeline ${name}`, entries);
  }
  if (jobs.length === 0) return;
  addDeploy(ctx, {
    system: "bitbucket",
    name: file.path,
    slug: `bitbucket:${file.path}`,
    cites,
    triggers,
    inputs,
    jobs,
  });
}

export function scanCi(ctx: ScanContext): void {
  const { workflows, gitlab, bitbucket } = ctx.deploy;
  for (const file of workflows) scanWorkflow(ctx, file);
  for (const file of gitlab) scanGitlabFile(ctx, file);
  if (bitbucket !== undefined) scanBitbucket(ctx, bitbucket);
}
