import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession, RunMount, RuntimeOptions } from "@majhi/acp";
import type { AccountConfig, AgentFrontmatter, Task, TeamOverride } from "@majhi/shared";
import { accountRuntime, secretName } from "../accounts/homes.ts";
import type { AdminAccess } from "../admin/access.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import type { Decisions } from "../decisions/api.ts";
import { UserError } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/index.ts";

/** An agent file and the account it runs on, checked. */
export interface ResolvedAgent {
  fm: AgentFrontmatter;
  instructions: string;
  account: AccountConfig;
  boss: string | undefined;
}

/** Reads the agent and its account. Throws a UserError the room can show as is. */
export async function resolveAgent(
  deps: { agents: AgentStore; config: ConfigService },
  agent: string,
): Promise<ResolvedAgent> {
  const stored = await deps.agents.get(agent);
  if (stored === undefined) throw new UserError(`Agent "${agent}" does not exist.`);
  if (!stored.ok) throw new UserError(`Agent "${agent}" is invalid: ${stored.errors.join("; ")}`);
  const fm = stored.agent.frontmatter;
  const { accounts, boss } = await deps.config.sections();
  const account = accounts[fm.account];
  if (account === undefined) throw new UserError(`Account "${fm.account}" is not in majhi.yaml.`);
  if (fm.scope !== "root" && account.org !== fm.scope && account.org !== "private") {
    throw new UserError(`@${fm.id} works in "${fm.scope}" and cannot use the account of "${account.org}".`);
  }
  return { fm, instructions: stored.agent.instructions, account, boss };
}

/** The agent with the owner's model and effort for one task put in place of its own. */
export function withOverride(agent: ResolvedAgent, override: TeamOverride | undefined): ResolvedAgent {
  if (override?.model === undefined && override?.effort === undefined) return agent;
  return {
    ...agent,
    fm: {
      ...agent.fm,
      ...(override.model === undefined ? {} : { model: override.model }),
      ...(override.effort === undefined ? {} : { effort: override.effort }),
    },
  };
}

export interface LaunchDeps {
  store: Store;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  secrets: SecretStore;
  majhiHome: string;
  admin?: AdminAccess | undefined;
  decisions?: Decisions | undefined;
}

export interface Launched {
  session: AgentSession;
  task: Task;
  /** The previous session was loaded. */
  resumed: boolean;
  /** The agent worked in this task before, so a new session needs its work carried over. */
  ranBefore: boolean;
  adminToken?: string | undefined;
  decideToken?: string | undefined;
  /** Fixed model and effort asked for (undefined for `auto` and for the ACP default). */
  model?: string | undefined;
  effort?: string | undefined;
}

/**
 * Opens the agent's ACP session in the task folder (SPEC 5.1): its account's home and key, the
 * fixed model and effort, majhi-admin for admin agents and majhi-decide for everyone, and the
 * previous session loaded unless it was handed off. Tokens are revoked when the start fails.
 */
export async function launch(
  deps: LaunchDeps,
  run: { task: string; agent: string; freshNext: boolean },
  agent: ResolvedAgent,
): Promise<Launched> {
  const { fm, account, boss } = agent;
  let apiKey: string | undefined;
  if (account.auth === "api-key" && account.key !== undefined) {
    apiKey = await deps.secrets.get(secretName(account.key));
    if (apiKey === undefined)
      throw new UserError(`The API key of ${fm.account} is missing. Add the account again.`);
  }
  const runtimeAccount = accountRuntime(deps.majhiHome, fm.account, account, apiKey);
  await deps.runtime.prepareHome(runtimeAccount);
  const task = deps.store.tasks.get(run.task);
  if (task === undefined) throw new UserError(`Task ${run.task} does not exist.`);

  const model = fm.model === "auto" ? undefined : fm.model;
  const effort = fm.effort === "auto" ? undefined : fm.effort;
  const resume = run.freshNext ? undefined : deps.store.runs.lastSessionId(run.task, run.agent);
  const ranBefore = resume !== undefined || deps.store.runs.ranBefore(run.task, run.agent);
  const admin = deps.admin?.attach({ task: run.task, agent: run.agent }, fm, boss);
  const decide = deps.decisions?.attachTool(run.task, run.agent);
  const mcpServers = [admin?.server, decide?.server].flatMap((s) => (s === undefined ? [] : [s]));
  let session: AgentSession;
  try {
    session = await deps.runtime.startSession({
      account: runtimeAccount,
      options: deps.options,
      cwd: task.folder,
      mounts: await repoMounts(task),
      ...(resume === undefined ? {} : { resume }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(mcpServers.length === 0 ? {} : { mcpServers }),
    });
  } catch (err) {
    if (admin !== undefined) deps.admin?.revoke(admin.token);
    if (decide !== undefined) deps.decisions?.revoke(decide.token);
    throw err;
  }
  return {
    session,
    task,
    resumed: resume !== undefined && session.sessionId === resume,
    ranBefore,
    adminToken: admin?.token,
    decideToken: decide?.token,
    model,
    effort,
  };
}

/**
 * What a runner needs besides the task folder: each task repo's `.git`, where the worktree keeps
 * its objects and refs. `config` and `hooks` are read-only, so a run cannot plant a hook or a
 * command in the config that the owner's own git would later run on the host.
 */
export async function repoMounts(task: Task): Promise<RunMount[]> {
  const mounts: RunMount[] = [];
  for (const repo of task.repos) {
    if (repo.worktree === undefined) continue;
    const gitDir = join(repo.source, ".git");
    if (!(await isDirectory(gitDir))) continue;
    // A read-only mount needs the folder to exist, or the run could create it and add hooks.
    await mkdir(join(gitDir, "hooks"), { recursive: true });
    mounts.push(
      { path: gitDir },
      { path: join(gitDir, "config"), readOnly: true },
      { path: join(gitDir, "hooks"), readOnly: true },
    );
  }
  return mounts;
}
