import {
  type ConnectionView,
  DEPLOY_KIND_LABEL,
  type DeployKind,
  type DeployRecord,
  type DeploySuggestion,
  type DeployTarget,
  DeployTargetSchema,
  type DeployVia,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";

export const KINDS: readonly DeployKind[] = ["github-workflow", "gitlab-pipeline", "vercel", "ssh"];

export type RollbackKind = "redeploy-previous" | "ssh";

/** What the form holds while the owner types: every field as text, nothing parsed yet. */
export interface TargetDraft {
  env: string;
  kind: DeployKind;
  connection: string;
  workflow: string;
  ref: string;
  vercelProject: string;
  vercelTarget: "preview" | "production";
  command: string;
  health: string;
  wait: string;
  watch: string;
  rollbackKind: RollbackKind;
  rollbackConnection: string;
  rollbackCommand: string;
}

export function emptyDraft(env: string): TargetDraft {
  return {
    env,
    kind: "github-workflow",
    connection: "",
    workflow: "deploy.yml",
    ref: "",
    vercelProject: "",
    vercelTarget: "preview",
    command: "",
    health: "",
    wait: "60",
    watch: "",
    rollbackKind: "redeploy-previous",
    rollbackConnection: "",
    rollbackCommand: "",
  };
}

/** The first target is staging, the second production, then the owner names it. */
export function defaultEnv(targets: readonly DeployTarget[]): string {
  return targets.length === 0 ? "staging" : targets.length === 1 ? "production" : "";
}

export function draftFromTarget(t: DeployTarget): TargetDraft {
  const draft: TargetDraft = {
    ...emptyDraft(t.env),
    kind: t.via.kind,
    connection: t.via.connection,
    health: t.verify.health ?? "",
    wait: String(t.verify.waitSeconds),
    watch: t.verify.watch ?? "",
    rollbackKind: t.rollback.kind,
  };
  if (t.rollback.kind === "ssh") {
    draft.rollbackConnection = t.rollback.connection;
    draft.rollbackCommand = t.rollback.command;
  }
  switch (t.via.kind) {
    case "github-workflow":
      draft.workflow = t.via.workflow;
      draft.ref = t.via.ref === "base" ? "" : t.via.ref;
      break;
    case "gitlab-pipeline":
      draft.ref = t.via.ref === "base" ? "" : t.via.ref;
      break;
    case "vercel":
      draft.vercelProject = t.via.project;
      draft.vercelTarget = t.via.target;
      break;
    case "ssh":
      draft.command = t.via.command;
      break;
  }
  return draft;
}

/** A suggestion that is not one click: the form opens with what majhi found. */
export function draftFromSuggestion(s: DeploySuggestion): TargetDraft {
  const draft = emptyDraft(s.env);
  draft.kind = s.kind;
  draft.connection = s.connection ?? "";
  draft.watch = s.watch ?? "";
  if (s.workflow !== undefined) draft.workflow = s.workflow;
  if (s.project !== undefined) draft.vercelProject = s.project;
  return draft;
}

/** Redeploy previous needs an earlier commit to start from, which only GitHub workflows and Vercel have. */
export function redeployProblem(kind: DeployKind): string | undefined {
  if (kind === "gitlab-pipeline") {
    return "A GitLab pipeline starts from a branch, not from an earlier commit. Write the rollback command.";
  }
  if (kind === "ssh") {
    return "An ssh command has no earlier commit to start from. Write the rollback command.";
  }
  return undefined;
}

function textField(c: ConnectionView, key: string): string | undefined {
  return c.fields[key]?.value;
}

function carries(kind: DeployKind, c: ConnectionView): boolean {
  switch (kind) {
    case "github-workflow":
      return c.type === "git" && textField(c, "provider") === "github";
    case "gitlab-pipeline":
      return c.type === "git" && textField(c, "provider") === "gitlab";
    case "vercel":
      return c.type === "env" && c.vars.VERCEL_TOKEN !== undefined;
    case "ssh":
      return c.type === "ssh";
  }
}

/** The workspace's connections that can carry a kind of deploy. */
export function connectionsFor(
  kind: DeployKind,
  all: readonly ConnectionView[],
  org: string,
): ConnectionView[] {
  return all.filter((c) => c.org === org && carries(kind, c));
}

export type Built = { ok: true; target: DeployTarget } | { ok: false; problem: string };

function viaOf(d: TargetDraft): DeployVia | string {
  if (d.connection === "") return "Choose a connection";
  const ref = d.ref.trim() === "" ? "base" : d.ref.trim();
  switch (d.kind) {
    case "github-workflow":
      return d.workflow.trim() === ""
        ? "Name the workflow file"
        : { kind: d.kind, connection: d.connection, workflow: d.workflow.trim(), ref };
    case "gitlab-pipeline":
      return { kind: d.kind, connection: d.connection, ref };
    case "vercel":
      return d.vercelProject.trim() === ""
        ? "Name the Vercel project"
        : { kind: d.kind, connection: d.connection, project: d.vercelProject.trim(), target: d.vercelTarget };
    case "ssh":
      return d.command.trim() === ""
        ? "Write the command"
        : { kind: d.kind, connection: d.connection, command: d.command.trim() };
  }
}

/** Checks the draft the way the server does, so the problem shows before Save. */
export function buildTarget(d: TargetDraft): Built {
  if (d.env.trim() === "") return { ok: false, problem: "Name the environment" };
  const via = viaOf(d);
  if (typeof via === "string") return { ok: false, problem: via };
  if (d.health.trim() === "" && d.watch === "") {
    return { ok: false, problem: "Name a health address or a watch" };
  }
  const waitSeconds = Number(d.wait);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 1800) {
    return { ok: false, problem: "Wait is a whole number of seconds, up to 1800" };
  }
  let rollback: DeployTarget["rollback"] = { kind: "redeploy-previous" };
  if (d.rollbackKind === "ssh") {
    if (d.rollbackConnection === "")
      return { ok: false, problem: "Choose an SSH connection for the rollback" };
    if (d.rollbackCommand.trim() === "") return { ok: false, problem: "Write the rollback command" };
    rollback = { kind: "ssh", connection: d.rollbackConnection, command: d.rollbackCommand.trim() };
  } else {
    const problem = redeployProblem(d.kind);
    if (problem !== undefined) return { ok: false, problem };
  }
  const parsed = DeployTargetSchema.safeParse({
    env: d.env.trim(),
    via,
    verify: {
      ...(d.health.trim() === "" ? {} : { health: d.health.trim() }),
      ...(d.watch === "" ? {} : { watch: d.watch }),
      waitSeconds,
    },
    rollback,
  });
  if (!parsed.success) return { ok: false, problem: parsed.error.issues[0]?.message ?? "Check the fields" };
  return { ok: true, target: parsed.data };
}

// Display -------------------------------------------------------------------

export const kindLabel = (kind: DeployKind): string => DEPLOY_KIND_LABEL[kind];

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** What the Via row names: the workflow file, the project, or the connection. */
export function viaName(via: DeployVia): string {
  switch (via.kind) {
    case "github-workflow":
      return via.workflow;
    case "vercel":
      return via.project;
    case "gitlab-pipeline":
    case "ssh":
      return via.connection;
  }
}

export interface StateLook {
  lamp: LampState;
  word: string;
}

/** The record's state as a lamp and a word. */
export function stateLook(r: DeployRecord): StateLook {
  switch (r.state) {
    case "live":
      return { lamp: "done", word: "Healthy" };
    case "rolled-back":
      return { lamp: "paused", word: "Rolled back by itself" };
    case "failed":
      return { lamp: "paused", word: "Failed" };
    case "held":
      return { lamp: "paused", word: "Held" };
    case "verifying":
      return { lamp: "working", word: "Checking" };
    case "queued":
    case "running":
      return { lamp: "working", word: "Deploying" };
  }
}

export const HISTORY_ROWS = 10;

/** The newest live record of each environment: the only rows that offer a rollback. */
export function rollbackRecordIds(history: readonly DeployRecord[]): Set<number> {
  const seen = new Set<string>();
  const ids = new Set<number>();
  for (const r of history) {
    if (seen.has(r.env)) continue;
    if (r.state === "live") ids.add(r.id);
    if (r.state !== "held") seen.add(r.env);
  }
  return ids;
}

export interface IncidentNote {
  commit: string;
  back: string | undefined;
  incident: string;
}

/** The newest failed or rolled-back record, when it opened an incident. */
export function incidentNote(history: readonly DeployRecord[]): IncidentNote | undefined {
  const r = history.find((h) => h.state === "failed" || h.state === "rolled-back");
  if (r?.incident === undefined) return undefined;
  const back = r.rollback?.ok === true ? r.rollback.commit : undefined;
  return {
    commit: shortSha(r.commit),
    back: back === undefined ? undefined : shortSha(back),
    incident: r.incident,
  };
}
