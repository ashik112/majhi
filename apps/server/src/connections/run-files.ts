import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMount } from "@majhi/acp";
import { MAJHI_RUN_CONNECTIONS_DIR } from "@majhi/acp";
import type { AgentFrontmatter, Task } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import type { SecretStore } from "../secrets/store.ts";
import { runConnections } from "./access.ts";
import type { GateConnection } from "./gate.ts";
import {
  type ConnectionUse,
  type HostService,
  hostAlias,
  type PlanDeps,
  planConnections,
  type RunPlan,
} from "./plan.ts";
import type { HeldSecret } from "./redact.ts";
import { ownerOnlyDir } from "./service.ts";

/**
 * Where a run's connection files live: `<majhi home>/run/connections/<folder>/`, owner-only. No read
 * mount can reach majhi's config folder, and the runner mounts exactly this folder, read-only, into
 * the run it belongs to (packages/acp runner/docker.ts). A session's folder goes when the session
 * ends, a background process's when the process does, and every leftover when majhi starts.
 */
export function runFilesRoot(majhiHome: string): string {
  return join(majhiHome, MAJHI_RUN_CONNECTIONS_DIR);
}

/** What a run holds of its connections once its files are written: for the gate, redaction and TASK.md. */
export interface RunConnections {
  /** The run's own folder. */
  dir: string;
  gate: GateConnection[];
  secrets: { name: string; value: string }[];
  uses: ConnectionUse[];
}

export interface PreparedRun extends RunConnections {
  env: Record<string, string>;
  servers: RunPlan["servers"];
  mounts: RunMount[];
  problems: string[];
  /** One line per service on this computer the run reaches, for the room. */
  notes: { id: string; text: string }[];
}

export interface RunFilesDeps {
  config: Pick<ConfigService, "sections">;
  secrets: Pick<SecretStore, "get">;
  majhiHome: string;
  /** The folder of a connection's own files. */
  connectionDir: (id: string) => string;
  browsersPath?: string | undefined;
  /** Bearer tokens of connections signed in with OAuth (5.14). */
  oauth?: PlanDeps["oauth"];
  /** The workspace's own git sign-in, for `git` connections. */
  gitToken?: PlanDeps["gitToken"];
  /** Whether a connection's one state is connected (5.14). */
  connected?: PlanDeps["connected"];
  /** What an MCP server said about its tools at its last Test. */
  toolAnnotations?: PlanDeps["toolAnnotations"];
  /**
   * Starts the forwarder of the services on this computer a run reaches, on the task's own network,
   * before the run starts. Rejects with a plain message when it cannot.
   */
  hostServices?: ((task: string, services: HostService[]) => Promise<unknown>) | undefined;
}

/**
 * The connections this agent's run of this task gets, with their files written to a folder of its
 * own. Undefined when it gets none, so most runs have no folder at all.
 */
export async function prepareRunConnections(
  deps: RunFilesDeps,
  task: Pick<Task, "id" | "org" | "connections">,
  fm: Pick<AgentFrontmatter, "id" | "scope">,
  kind: "session" | "process",
): Promise<PreparedRun | undefined> {
  const sections = await deps.config.sections();
  const held = runConnections({
    agent: { id: fm.id, scope: fm.scope },
    task: { org: task.org, connections: task.connections ?? [] },
    orgs: sections.orgs,
    global: sections.connections,
  });
  if (held.length === 0) return undefined;
  const root = runFilesRoot(deps.majhiHome);
  await ownerOnlyDir(root);
  const dir = join(root, `${kind}-${randomBytes(8).toString("hex")}`);
  await ownerOnlyDir(dir);
  try {
    const plan = await planConnections(held, dir, deps);
    for (const file of plan.files) await writeFile(join(dir, file.name), file.data, { mode: 0o600 });
    for (const profile of plan.profiles) await ownerOnlyDir(profile);
    const reach = await startHostServices(deps, task.id, plan);
    return {
      dir,
      gate: plan.gate,
      secrets: plan.secrets,
      uses: plan.uses.filter((u) => !reach.failed.includes(u.id)),
      env: plan.env,
      servers: plan.servers,
      mounts: [{ path: dir, readOnly: true }, ...plan.profiles.map((path) => ({ path }))],
      problems: [...plan.problems, ...reach.problems],
      notes: reach.notes,
    };
  } catch (err) {
    await removeRunFiles(dir);
    throw err;
  }
}

/**
 * Starts the forwarder of each service on this computer the run reaches. One that cannot start is
 * left out of the run, with the reason for the room.
 */
async function startHostServices(
  deps: Pick<RunFilesDeps, "hostServices">,
  task: string,
  plan: Pick<RunPlan, "hostServices">,
): Promise<{ failed: string[]; problems: string[]; notes: { id: string; text: string }[] }> {
  const out = {
    failed: [] as string[],
    problems: [] as string[],
    notes: [] as { id: string; text: string }[],
  };
  if (plan.hostServices.length === 0) return out;
  try {
    if (deps.hostServices === undefined) throw new Error("agents here do not run in containers");
    await deps.hostServices(task, plan.hostServices);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    for (const s of plan.hostServices) {
      out.failed.push(s.id);
      out.problems.push(`${hostAlias(s.id)} could not start, so the run does not get it: ${why}`);
    }
    return out;
  }
  for (const s of plan.hostServices) {
    out.notes.push({
      id: s.id,
      text: `${hostAlias(s.id)} is reachable from this task: ports ${s.ports.join(", ")}. Nothing else on this computer is.`,
    });
  }
  return out;
}

/**
 * Every secret value a run of this task could hold, for what is shown of the task outside a run,
 * like REPORT.md: the connections of the task's org and the ones the task names.
 */
export async function taskSecrets(
  deps: RunFilesDeps,
  task: Pick<Task, "org" | "connections">,
): Promise<HeldSecret[]> {
  const sections = await deps.config.sections();
  const held = runConnections({
    agent: { scope: "root" },
    task: { org: task.org, connections: task.connections ?? [] },
    orgs: sections.orgs,
    global: sections.connections,
  });
  if (held.length === 0) return [];
  // Nothing is written: only the plan's secret values are read.
  return (await planConnections(held, runFilesRoot(deps.majhiHome), deps)).secrets;
}

export async function removeRunFiles(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** At start no run is alive yet, so every folder left from before goes. */
export async function sweepRunFiles(majhiHome: string): Promise<void> {
  await rm(runFilesRoot(majhiHome), { recursive: true, force: true });
}
