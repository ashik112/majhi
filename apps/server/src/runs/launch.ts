import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSession,
  buildEnv,
  type RunMount,
  type RuntimeOptions,
  type StdioServerSpec,
} from "@majhi/acp";
import type { AccountConfig, AgentFrontmatter, Task, TeamOverride } from "@majhi/shared";
import { accountRuntime, secretName } from "../accounts/homes.ts";
import { ADMIN_SERVER_NAME, type AdminAccess } from "../admin/access.ts";
import { isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import { resolvePath } from "../config/load.ts";
import type { ConfigService } from "../config/service.ts";
import type { Decisions } from "../decisions/api.ts";
import { DECIDE_SERVER_NAME } from "../decisions/service.ts";
import { UserError } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import type { ProcessLaunch } from "../processes/manager.ts";
import type { RoomAccess, ToolServer } from "../rooms/access.ts";
import { type GatedTool, gateTools, SERENA_SERVER_NAME } from "../rooms/gating.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/index.ts";
import { blockedPaths, checkReadMount, projectsFor, type ReadPolicy } from "../tasks/read-mounts.ts";
import { gitAttribution } from "./attribution.ts";
import { keepSerenaOutOfGit, type SerenaLaunch, serenaServer } from "./serena.ts";

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
  config: ConfigService;
  majhiHome: string;
  admin?: AdminAccess | undefined;
  decisions?: Decisions | undefined;
  /** majhi-room and majhi-tasks (Phase 3). */
  rooms?: RoomAccess | undefined;
  /** Serena can start in the runner container (5.9 item 6). Undefined when agents do not run in one. */
  serena?: SerenaLaunch | undefined;
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
  roomTokens?: { server: ToolServer; token: string }[] | undefined;
  /** The MCP servers the session was given, by name (recorded on the run). */
  tools: string[];
  /** Things the room should hear about this start, such as a tool left out. */
  notices: string[];
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
  const { fm, boss } = agent;
  const runtimeAccount = await runtimeAccountOf(deps, agent);
  await deps.runtime.prepareHome(runtimeAccount);
  const task = deps.store.tasks.get(run.task);
  if (task === undefined) throw new UserError(`Task ${run.task} does not exist.`);

  const attribution = await gitAttribution(deps, task, run.agent);
  const model = fm.model === "auto" ? undefined : fm.model;
  const effort = fm.effort === "auto" ? undefined : fm.effort;
  const resume = run.freshNext ? undefined : deps.store.runs.lastSessionId(run.task, run.agent);
  const ranBefore = resume !== undefined || deps.store.runs.ranBefore(run.task, run.agent);
  const caller = { task: run.task, agent: run.agent };
  const worktrees = task.repos.map((r) => r.worktree ?? join(task.folder, r.project));
  const gated = gateTools(fm, {
    boss,
    teamSize: task.team.length,
    soloLead: task.mode === "lead" && task.kind !== "chat" && task.team[0] === run.agent && !isBossChat(task),
    opsTask: task.kind === "ops",
    containersOn: deps.rooms?.canRunContainers ?? false,
    serena: deps.serena !== undefined,
    hasWorktrees: worktrees.length > 0,
  });
  const on = (name: string) => gated.includes(name as GatedTool);
  const admin = on(ADMIN_SERVER_NAME) ? deps.admin?.attach(caller, fm, boss) : undefined;
  const decide = on(DECIDE_SERVER_NAME) ? deps.decisions?.attachTool(run.task, run.agent) : undefined;
  const rooms = deps.rooms?.attach(caller, gated);
  const notices: string[] = [];
  let serena: StdioServerSpec | undefined;
  const firstWorktree = worktrees[0];
  if (on(SERENA_SERVER_NAME) && deps.serena !== undefined && firstWorktree !== undefined) {
    // A worktree the owner removed by hand must not stop the start: the agent just has no Serena.
    if (
      await keepSerenaOutOfGit(firstWorktree).then(
        () => true,
        () => false,
      )
    ) {
      serena = serenaServer(deps.serena, firstWorktree, agent.account.tool);
    }
  }
  const mcpServers = [admin?.server, decide?.server, ...(rooms?.servers ?? []), serena].flatMap((s) =>
    s === undefined ? [] : [s],
  );
  let session: AgentSession;
  try {
    session = await deps.runtime.startSession({
      account: runtimeAccount,
      options: deps.options,
      cwd: task.folder,
      git: attribution.git,
      task: task.id,
      mounts: [
        // Read-only checkouts first: a task repo's own .git below one stays writable.
        ...(await readMounts(deps, task, run.agent, fm.scope)),
        ...(await repoMounts(task, { readOnly: await readOnlyRepos(deps.config, task), guardRefs: true })),
        ...hooksMount(attribution.hooks),
      ],
      ...(resume === undefined ? {} : { resume }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(mcpServers.length === 0 ? {} : { mcpServers }),
    });
  } catch (err) {
    if (admin !== undefined) deps.admin?.revoke(admin.token);
    if (decide !== undefined) deps.decisions?.revoke(decide.token);
    if (rooms !== undefined) deps.rooms?.revoke(rooms.tokens);
    throw err;
  }
  return {
    session,
    task,
    resumed: resume !== undefined && session.sessionId === resume,
    ranBefore,
    adminToken: admin?.token,
    decideToken: decide?.token,
    roomTokens: rooms?.tokens,
    tools: mcpServers.map((m) => m.name),
    notices,
    model,
    effort,
  };
}

/**
 * What this agent reads in every run, read-only, at the same path as on the owner's machine: the
 * registered projects it may see (a root agent all of them, an org agent its own org's), then the
 * folders the owner mentioned for it and the task's investigation repos. The task's own worktrees
 * stay read-write. Each folder is checked again, so one that moved is left out rather than failing
 * the start. The runner's mount guard is the last check.
 */
export async function readMounts(
  deps: { config: ConfigService; majhiHome: string; secrets: Pick<SecretStore, "keyFile"> },
  task: Task,
  agent: string,
  scope: string,
): Promise<RunMount[]> {
  const loaded = await deps.config.load();
  if (loaded.state.status !== "loaded") return [];
  const { hostHome } = deps.config.paths;
  const blocked = blockedPaths({
    majhiHome: deps.majhiHome,
    hostHome,
    protectedPaths: [deps.secrets.keyFile],
  });
  const { workspaces, tasksDir } = loaded.state.config;
  const sections = await deps.config.sections();
  const projects = projectsFor(
    scope,
    Object.values(sections.projects).map((p) => ({ org: p.org, path: resolvePath(p.path, hostHome) })),
  );
  const mounts: RunMount[] = [];
  const add = async (path: string, policy: ReadPolicy) => {
    const ok = await checkReadMount(path, policy).catch(() => undefined);
    if (ok !== undefined && !mounts.some((m) => m.path === ok)) mounts.push({ path: ok, readOnly: true });
  };
  // A registered project is the owner's own choice, even outside the roots: it is its own root.
  for (const p of projects) {
    await add(p.path, { roots: [p.path], projects: [], scope: "root", blocked, tasksDir });
  }
  // Mentioned folders and investigation repos must lie inside the workspace roots.
  const wanted = (task.readMounts ?? []).filter((m) => m.agent === undefined || m.agent === agent);
  for (const m of wanted) {
    await add(m.path, { roots: workspaces, projects: [], scope: "root", blocked, tasksDir });
  }
  return mounts;
}

/**
 * The task's repos of protected projects that the owner did not let agents write in for this
 * task. Their worktrees are mounted read-only in agent runs.
 */
export async function readOnlyRepos(config: ConfigService, task: Task): Promise<Set<string>> {
  const loaded = await config.load();
  if (loaded.state.status !== "loaded") return new Set();
  const projects = (await config.sections()).projects;
  return new Set(
    task.repos
      .filter((r) => projects[r.project]?.protected === true && r.writes !== true)
      .map((r) => r.project),
  );
}

/** majhi's hooks folder, read-only. Every run has it: the hooks keep its git on its own branches. */
function hooksMount(hooks: string): RunMount[] {
  return [{ path: hooks, readOnly: true }];
}

/** The agent's account as the runtime needs it, with its API key when it has one. */
async function runtimeAccountOf(deps: Pick<LaunchDeps, "secrets" | "majhiHome">, agent: ResolvedAgent) {
  const { fm, account } = agent;
  let apiKey: string | undefined;
  if (account.auth === "api-key" && account.key !== undefined) {
    apiKey = await deps.secrets.get(secretName(account.key));
    if (apiKey === undefined)
      throw new UserError(`The API key of ${fm.account} is missing. Add the account again.`);
  }
  return accountRuntime(deps.majhiHome, fm.account, account, apiKey);
}

/**
 * What a background process of the agent runs with (5.15): the same account, environment and
 * mounts as its session, so a command behaves the same in the agent's shell and in majhi's.
 */
export async function processLaunch(
  deps: Pick<LaunchDeps, "store" | "options" | "secrets" | "majhiHome"> & {
    agents: AgentStore;
    config: ConfigService;
  },
  taskId: string,
  agentId: string,
): Promise<ProcessLaunch> {
  const task = deps.store.tasks.get(taskId);
  if (task === undefined) throw new UserError(`Task ${taskId} does not exist.`);
  const resolved = await resolveAgent(deps, agentId);
  const account = await runtimeAccountOf(deps, resolved);
  const attribution = await gitAttribution(deps, task, agentId);
  return {
    folder: task.folder,
    env: buildEnv(account, deps.options.base, attribution.git),
    account,
    mounts: [
      ...(await readMounts(deps, task, agentId, resolved.fm.scope)),
      ...(await repoMounts(task, { readOnly: await readOnlyRepos(deps.config, task), guardRefs: true })),
      ...hooksMount(attribution.hooks),
    ],
  };
}

/**
 * What a runner needs besides the task folder: each task repo's `.git`, where the worktree keeps
 * its objects and refs. `config` and `hooks` are read-only, so a run cannot plant a hook or a
 * command in the config that the owner's own git would later run on the host. A repo in `readOnly`
 * gets only its worktree, read-only. For an agent's run (`guardRefs`) the refs are read-only too, but
 * for majhi's task branches: see `refMounts`.
 */
export async function repoMounts(
  task: Task,
  options: { readOnly?: ReadonlySet<string>; guardRefs?: boolean } = {},
): Promise<RunMount[]> {
  const readOnly = options.readOnly ?? new Set<string>();
  const mounts: RunMount[] = [];
  for (const repo of task.repos) {
    if (repo.worktree === undefined) continue;
    // A protected project agents may not write in: its worktree is read-only, and its .git is not
    // mounted writable, so no commit or ref can be made there.
    if (readOnly.has(repo.project)) {
      mounts.push({ path: repo.worktree, readOnly: true });
      continue;
    }
    const gitDir = join(repo.source, ".git");
    if (!(await isDirectory(gitDir))) continue;
    // A read-only mount needs the folder to exist, or the run could create it and add hooks.
    await mkdir(join(gitDir, "hooks"), { recursive: true });
    mounts.push(
      { path: gitDir },
      { path: join(gitDir, "config"), readOnly: true },
      { path: join(gitDir, "hooks"), readOnly: true },
    );
    if (options.guardRefs === true) mounts.push(...(await refMounts(gitDir, repo.branch)));
  }
  return mounts;
}

/**
 * A run's refs: branches, remote-tracking refs and tags read-only, but `refs/heads/task`, where
 * majhi's task branches live. majhi's hooks refuse every other ref change git makes in a transaction,
 * but git writes the branch of a `git branch -C` (copy) without one, so the hooks never see it; a
 * read-only folder refuses it, and a hand-written ref file too. A packed ref changes as a new loose
 * file, so it is covered the same way. A repo whose working branch the owner named outside `task/`
 * keeps only the hooks: that branch must stay writable.
 */
async function refMounts(gitDir: string, branch: string): Promise<RunMount[]> {
  if (!branch.startsWith("task/")) return [];
  const refs = join(gitDir, "refs");
  for (const dir of [join(refs, "heads", "task"), join(refs, "remotes"), join(refs, "tags")]) {
    await mkdir(dir, { recursive: true });
  }
  return [
    { path: join(refs, "heads"), readOnly: true },
    { path: join(refs, "heads", "task") },
    { path: join(refs, "remotes"), readOnly: true },
    { path: join(refs, "tags"), readOnly: true },
  ];
}
