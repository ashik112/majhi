import { randomUUID } from "node:crypto";
import {
  ABSTAIN,
  type CommandName,
  commands,
  type Fact,
  OpenMrsResultSchema,
  PRIVATE,
  type RoomItem,
  type TaskId,
} from "@majhi/shared";
import type { AccountService } from "../accounts/service.ts";
import type { AdminService } from "../admin/service.ts";
import { startsWork } from "../autonomy/policy.ts";
import type { AutonomyService } from "../autonomy/service.ts";
import type { Dispatch } from "../commands/dispatch.ts";
import type { ConfigService } from "../config/service.ts";
import type { DecisionService } from "../decisions/service.ts";
import type { FindingsService } from "../findings/service.ts";
import { defaultBranch, git } from "../git/git.ts";
import { shipReadiness } from "../handoff/ready.ts";
import type { HandoffService } from "../handoff/service.ts";
import type { MemoryService } from "../memory/service.ts";
import { repoFacts } from "../memory/task-git.ts";
import { HOST_LABEL, type MrService } from "../mrs/service.ts";
import type { RoomService } from "../room/service.ts";
import type { IdleWatch } from "../rooms/idle-watch.ts";
import type { RepoScanner } from "../scan/scanner.ts";
import type { Store } from "../store/index.ts";
import { captainAnsweredLine } from "../tasks/cards.ts";
import type { CleanupService } from "../tasks/cleanup.ts";
import type { TaskFolderSweep } from "../tasks/folder-sweep.ts";
import type { TaskService } from "../tasks/service.ts";
import { callOutcome, toolItemIdOf } from "./call-outcome.ts";
import type { Lanes } from "./lanes.ts";
import { askedSentence, SHIP_ROW } from "./levels.ts";
import { laneScopes } from "./memory-scopes.ts";
import { scopeOfTask } from "./own-work.ts";
import { ownWorkSecondOpinion } from "./own-work-second.ts";
import { answerFor, widenedNote } from "./permission-rules.ts";
import type { ApprovalCard, CaptainPorts, NewRepo, QuestionCard, ShipCheck, SignInStall } from "./ports.ts";
import type { CaptainRepo } from "./repo.ts";
import { upkeepWorld } from "./upkeep-world.ts";

/**
 * The upkeep chores' ports over majhi's own services (SPEC 5.18). Each reads only the workspace it
 * is given, and acts through majhi's own paths: Ship, the approval cards, the task answers, the
 * curator, projects.register, the cleanup service and the idle watch. Commands run with the captain
 * as the actor, so the owner-only checks of each command hold for it too.
 */

export interface WorldDeps {
  /** Why the machine cannot take more work now, or undefined. */
  machineBusy?: () => string | undefined;
  store: Store;
  accounts: AccountService;
  config: ConfigService;
  tasks: TaskService;
  mrs: MrService;
  room: RoomService;
  admin: AdminService;
  autonomy: AutonomyService;
  decisions: DecisionService;
  memory: MemoryService;
  findings: FindingsService;
  curate: (fact: Fact, off?: ReadonlySet<string>) => Promise<{ reason?: string }>;
  scanner: RepoScanner;
  cleanup: CleanupService;
  folders?: TaskFolderSweep;
  idle: IdleWatch;
  runs: { working(task: string): string[]; notify(task: string, agent: string, text: string): void };
  lanes: Lanes;
  repo: CaptainRepo;
  /** Whether the owner is typing in a task now. */
  typing: (task: string) => boolean;
  /** Alias suggestions for a repo, from its folder and package names (the project card's scan). */
  aliasesOf: (path: string, id: string) => Promise<string[]>;
  /** Projects the owner protects: Own work never approves a change in one of them. */
  protectedProjects: () => Promise<ReadonlySet<string>>;
  /** The command dispatcher, bound once the server made it. */
  dispatch: () => Dispatch | undefined;
  /** The checked hand-off, bound once the server made it. Absent: ship readiness is the cheap checks only. */
  handoff?: (() => HandoffService | undefined) | undefined;
}

/** The most waiting memories one look reads. */
const PENDING_LIMIT = 1_000;
/** The finished tasks a follow-ups run compares with. */
const DONE_TASKS_READ = 15;

export function captainWorld(deps: WorldDeps): CaptainPorts {
  const sweepOptions = async (org: string) => {
    const { cleanup } = await deps.config.settings();
    return { hours: cleanup.free_after_hours, worktreeDays: cleanup.worktree_after_days, org };
  };
  const { store } = deps;
  const orgOfTask = (id: string) => store.tasks.get(id)?.org ?? PRIVATE;
  /** Open tasks of the workspace, without chats and lanes. */
  const tasksOf = (org: string) =>
    store.tasks
      .list(false)
      .filter((t) => (t.org ?? PRIVATE) === org && t.chat !== true && t.status !== "done");

  /** Runs a command as the captain. Returns its output and the config commit it made, if any. */
  const run = async (
    command: CommandName,
    input: unknown,
    reason: string,
    task?: string,
  ): Promise<{ output: unknown; commit?: string }> => {
    const dispatch = deps.dispatch();
    if (dispatch === undefined) throw new Error("majhi's commands are not ready yet");
    const captain = await deps.lanes.boss();
    if (captain === undefined) throw new Error("there is no captain");
    const history = deps.config.history;
    const before = commands[command].risk === "read" ? undefined : await history.head();
    const meta = {
      actor: { kind: "agent" as const, id: captain },
      reason,
      ...(task === undefined ? {} : { task }),
    };
    const result = await dispatch(command, input, JSON.stringify(meta));
    if (!result.ok) throw new Error([result.error.error, ...(result.error.details ?? [])].join(". "));
    if (before === undefined) return { output: result.output };
    const made = (await history.since(before)).filter((c) => c.subject.startsWith(`${command}:`));
    const commit = made.at(-1)?.commit;
    return { output: result.output, ...(commit === undefined ? {} : { commit }) };
  };

  const pendingOwnerCards = (task: string) => {
    deps.room.flush(task);
    return (["approval", "ask", "choice", "owner-question", "secret-request", "permission"] as const).some(
      (type) => store.room.pendingOfType(task, type).length > 0,
    );
  };

  const branchTip = async (source: string, branch: string) =>
    (await git(source, ["rev-parse", "--verify", `refs/heads/${branch}`]).catch(() => "")).trim();

  const questionOf = (task: string, item: RoomItem): QuestionCard | undefined => {
    switch (item.type) {
      case "choice":
        return item.state === "pending"
          ? {
              task,
              item: item.id,
              agent: item.agent ?? "agent",
              kind: "choice",
              text: item.question,
              options: item.options.map((o) => ({ id: o.id, label: o.label })),
            }
          : undefined;
      case "ask": {
        if (item.state !== "pending") return undefined;
        const [q, ...more] = item.questions;
        if (q === undefined) return undefined;
        return {
          task,
          item: item.id,
          agent: item.agent,
          kind: "ask",
          text: more.length === 0 ? q.question : `${q.question} (and ${more.length} more)`,
          // Several questions, or free text only: the owner's to answer.
          options: more.length === 0 ? q.options.map((o) => ({ id: o.id, label: o.label })) : [],
          question: q.id,
        };
      }
      case "owner-question":
        return item.state === "pending"
          ? {
              task,
              item: item.id,
              agent: item.agent,
              kind: "owner-question",
              text: item.text ?? "A question in plain text",
              options: item.choices.map((c) => ({ id: c, label: c })),
            }
          : undefined;
      case "permission":
        // Only "once" answers: a remembered allow or deny is the owner's to give.
        return item.state === "pending" && item.connection === undefined
          ? {
              task,
              item: item.id,
              agent: item.agent,
              kind: "permission",
              text: item.title,
              options: item.options
                .filter((o) => o.kind === "allow_once" || o.kind === "reject_once")
                .map((o) => ({
                  id: o.id,
                  label: o.name,
                  effect: o.kind === "allow_once" ? ("allow" as const) : ("deny" as const),
                })),
            }
          : undefined;
      default:
        return undefined;
    }
  };

  return {
    // -------------------------------------------------------------------------
    // Ship finished work

    async reviewTasks(org) {
      const out = [];
      for (const summary of tasksOf(org)) {
        if (summary.status !== "review") continue;
        const task = store.tasks.get(summary.id);
        if (task === undefined || task.repos.length === 0) continue;
        const heads: string[] = [];
        for (const r of task.repos)
          heads.push(`${r.project}@${(await branchTip(r.source, r.branch)).slice(0, 12)}`);
        out.push({ id: task.id, title: task.title, heads: heads.join(",") });
      }
      return out;
    },

    async shipCheck(_org, id, except): Promise<ShipCheck> {
      const base = await shipReadiness(deps, id, except);
      if (!base.ready) return base;
      // The checked hand-off (SPEC 5.18): tests, build, lint and the review of this head, run once.
      const handoff = deps.handoff?.();
      if (handoff === undefined) return base;
      const checked = await handoff.ensure(id, { force: false });
      if (checked.verdict === "red") {
        const first = [...checked.failures, ...checked.held][0] ?? "the check did not pass";
        return { ready: false, why: `the hand-off check failed: ${first.split("\n")[0]}` };
      }
      return { ...base, checked: checked.summary.replace(/^Checked: /, "") };
    },

    async ship(_org, id, how, reason) {
      const task = store.tasks.get(id);
      if (task === undefined) throw new Error(`There is no task ${id}`);
      const options = await deps.mrs.shipOptions(id);
      const changed = options.changed ?? [];
      const before = new Map<string, string>();
      for (const c of changed) {
        const repo = task.repos.find((r) => r.project === c.project);
        if (repo !== undefined) before.set(c.project, await branchTip(repo.source, c.base));
      }
      await run("tasks.merge", { id, done: true, push: how.push }, reason, id);
      const repos = [];
      for (const c of changed) {
        const repo = task.repos.find((r) => r.project === c.project);
        const was = before.get(c.project);
        if (repo === undefined || was === undefined || was === "") continue;
        const now = await branchTip(repo.source, c.base);
        if (now !== "" && now !== was)
          repos.push({ project: c.project, source: repo.source, into: c.base, before: was, after: now });
      }
      const into = [...new Set(changed.map((c) => c.base))].join(", ");
      if (how.push) {
        return {
          text: `Shipped ${id} to ${into} and pushed: ${task.title}`,
          undoNote:
            "It was pushed, and a push cannot be undone. The captain pushes only after the checks pass",
        };
      }
      return {
        text: `Shipped ${id} to ${into}: ${task.title}`,
        ...(repos.length === 0
          ? { undoNote: "The merge moved no branch" }
          : { undo: { kind: "revert" as const, repos } }),
      };
    },

    async resolveShip(_org, id, reason) {
      await run("tasks.resolveShip", { id, action: "merge" }, reason, id);
    },

    async shipReady(_org, id, line) {
      deps.tasks.cards.shipReady(id, line);
    },

    async mrReady(_org, id) {
      const options = await deps.mrs.shipOptions(id);
      if (!options.mr.ok) {
        return {
          ok: false,
          why: options.mr.why ?? "it cannot open a merge request now",
          ...(options.mr.fix === undefined ? {} : { fix: options.mr.fix }),
        };
      }
      return { ok: true, host: options.host === undefined ? "its host" : HOST_LABEL[options.host] };
    },

    async openMrs(_org, id, reason) {
      const out = OpenMrsResultSchema.parse((await run("tasks.openMrs", { id }, reason, id)).output);
      const options = await deps.mrs.shipOptions(id);
      const failed = out.repos.find((r) => r.outcome === "failed");
      return {
        urls: out.repos.flatMap((r) => (r.url === undefined ? [] : [r.url])),
        host: options.host === undefined ? "its host" : HOST_LABEL[options.host],
        ...(failed === undefined ? {} : { failed: `${failed.project}: ${failed.detail}` }),
      };
    },

    async answerTasks(org) {
      const out = [];
      for (const summary of tasksOf(org)) {
        if (summary.status !== "review" || deps.runs.working(summary.id).length > 0) continue;
        if (pendingOwnerCards(summary.id)) continue;
        const task = store.tasks.get(summary.id);
        if (task === undefined) continue;
        try {
          const options = await deps.mrs.shipOptions(task.id);
          if ((options.changed ?? []).length > 0 || (options.protected ?? []).length > 0) continue;
          // Commits are not the only change: uncommitted files in a worktree are work too.
          const diffs = await deps.tasks.diff(task.id);
          if (diffs.some((d) => d.error !== undefined || d.uncommitted || d.files.length > 0)) continue;
        } catch {
          continue;
        }
        const lead = task.team[0];
        deps.room.flush(task.id);
        const message = store.room
          .page(task.id, 60)
          .items.find(
            (i) => i.type === "agent" && i.text.trim() !== "" && (lead === undefined || i.agent === lead),
          );
        out.push({
          id: task.id,
          title: task.title,
          lead,
          report: message?.type === "agent" ? { text: message.text.trim(), at: message.at } : undefined,
        });
      }
      return out;
    },

    async closeAnswer(_org, id, reason) {
      await run("tasks.close", { id }, reason, id);
    },

    async askChanges(_org, id, text) {
      const lead = store.tasks.get(id)?.team[0];
      await deps.tasks.send({
        task: id,
        text,
        attachments: [],
        mode: "queue",
        ...(lead === undefined ? {} : { agent: lead }),
      });
    },

    async settleMergeCard(_org, card, line) {
      const captain = (await deps.lanes.boss()) ?? "captain";
      await deps.admin.captainInstead(card.task, card.item, line, captain);
    },

    // -------------------------------------------------------------------------
    // Approval cards

    approvals(org) {
      const out: ApprovalCard[] = [];
      for (const t of tasksOf(org)) {
        if (deps.lanes.orgOf(t.id) !== undefined) continue;
        deps.room.flush(t.id);
        for (const item of store.room.pendingOfType(t.id, "approval")) {
          if (item.type !== "approval") continue;
          // A card left for a missing sign-in is looked at again: the owner may have fixed it.
          if (item.autonomy !== undefined && item.autonomy.fix === undefined) continue;
          // Autonomous mode decides the calls of autonomous tasks itself.
          if (deps.autonomy.isAutonomous(t.id)) continue;
          const call = deps.admin.cardCall(t.id, item.id);
          if (call === undefined) continue;
          out.push({
            task: t.id,
            item: item.id,
            agent: item.agent,
            command: call.command,
            input: call.input,
            summary: item.summary,
          });
        }
      }
      return out;
    },

    async cardVerdict(org, card, authority) {
      const call = deps.admin.cardCall(card.task, card.item);
      if (call === undefined) return { decision: "left", why: "The card is no longer waiting" };
      const verdict = await deps.autonomy.decide(
        { task: card.task, agent: card.agent },
        call.command,
        call.parsed,
        call.input,
        { confirm: false, reason: "" },
      );
      if (verdict.decision === "refused")
        return {
          decision: "left",
          why: `The captain never does this: ${verdict.why.replace(/^Refused: /, "")}`,
          risky: true,
        };
      if (verdict.decision === "left") return verdict;
      const row = startsWork(call.command, call.parsed) ? "start" : SHIP_ROW[call.command];
      if (row !== undefined && authority[row] !== "decide") {
        const name = (await deps.config.sections()).orgs[org]?.name ?? (org === PRIVATE ? "Private" : org);
        return { decision: "left", why: askedSentence(row, name) };
      }
      return verdict;
    },

    async decideCard(_org, card, verdict) {
      const captain = (await deps.lanes.boss()) ?? "captain";
      return deps.admin.captainDecide(card.task, card.item, verdict, captain);
    },

    // -------------------------------------------------------------------------
    // Agents' questions

    questions(org) {
      const out: QuestionCard[] = [];
      for (const t of tasksOf(org)) {
        deps.room.flush(t.id);
        for (const type of ["ask", "choice", "owner-question", "permission"] as const) {
          for (const item of store.room.pendingOfType(t.id, type)) {
            const card = questionOf(t.id, item);
            if (card !== undefined) out.push(card);
          }
        }
      }
      return out;
    },

    async ownScope(org, task) {
      const found = store.tasks.get(task);
      if (found === undefined || (found.org ?? PRIVATE) !== org || found.noAutonomy === true)
        return undefined;
      // Only what the captain created or started: the tasks autonomous mode runs.
      if (!deps.autonomy.isAutonomous(task)) return undefined;
      return scopeOfTask(found, await deps.protectedProjects());
    },

    ownSecondOpinion: (card, scope) =>
      ownWorkSecondOpinion(
        deps.decisions,
        { text: card.text, task: card.task, item: card.item, agent: card.agent },
        scope,
      ),

    async answer(_org, card, option, reason) {
      // Recorded as the captain's answer, never the owner's (5.18).
      const captain = (await deps.lanes.boss()) ?? "captain";
      let answered: RoomItem;
      let widened: string | undefined;
      switch (card.kind) {
        case "permission": {
          // A tool a rule covers is allowed for the task, so its next call does not ask again.
          const item = deps.room.get(card.task, card.item);
          const chosen = item?.type === "permission" ? answerFor(item.title, item.options, option) : option;
          if (item?.type === "permission") widened = widenedNote(item.title, option, chosen);
          answered = deps.tasks.answerPermission(card.task, card.item, chosen, captain);
          break;
        }
        case "choice":
          answered = await deps.tasks.answerChoice(card.task, card.item, option, captain);
          break;
        case "ask":
          answered = await deps.tasks.answerAsk(
            card.task,
            card.item,
            { [card.question ?? "q"]: option },
            captain,
          );
          break;
        case "owner-question":
          answered = await deps.tasks.answerQuestion(card.task, card.item, option, captain);
          break;
      }
      deps.room.post(card.task as TaskId, `captain:${randomUUID()}`, {
        type: "system",
        level: "info",
        text: `${captainAnsweredLine(answered, reason)}${widened === undefined ? "" : `. ${widened}`}`,
      });
    },

    callOutcome(task, item) {
      const perm = deps.room.get(task, item);
      const toolId = perm === undefined ? undefined : toolItemIdOf(perm);
      return callOutcome(perm, toolId === undefined ? undefined : deps.room.get(task, toolId));
    },

    async flagLoop(_org, card, line, nudge) {
      deps.room.post(card.task as TaskId, `captain:${randomUUID()}`, {
        type: "system",
        level: "warn",
        text: `${line}. The captain left its question for the owner.`,
      });
      deps.runs.notify(card.task, card.agent, nudge);
    },

    laneRest: (org) => deps.lanes.rest(org),

    async askLane(org, text) {
      const told = await deps.lanes.tell(org, text, "The captain's upkeep asked about a question");
      return told.sent ? { sent: true } : { sent: false, why: told.why };
    },

    // -------------------------------------------------------------------------
    // Follow-ups and findings

    findings: deps.findings,
    upkeep: upkeepWorld({
      run,
      store,
      now: () => new Date(),
      machineBusy: deps.machineBusy,
      wake: (org, line) => deps.autonomy.news(line, org),
    }),
    followUps: {
      openThreads: (org) =>
        deps.memory.project
          .threads({ status: "open", limit: 500 })
          .filter((t) => (t.org ?? PRIVATE) === org)
          .reverse(),
      task: (id) => {
        const t = store.tasks.get(id);
        return t === undefined ? undefined : { id: t.id, title: t.title, status: t.status };
      },
      async doneSince(org, project, since) {
        const done = store.tasks
          .list(true)
          .filter(
            (t) =>
              t.status === "done" &&
              t.chat !== true &&
              (t.org ?? PRIVATE) === org &&
              t.updatedAt > since &&
              (project === undefined || t.repos.some((r) => r.project === project)),
          )
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, DONE_TASKS_READ);
        const out = [];
        for (const summary of done) {
          const task = store.tasks.get(summary.id);
          if (task === undefined) continue;
          const record = deps.memory.project.record(task.id);
          const commits = (await Promise.all(task.repos.map((r) => repoFacts(r, task.createdAt)))).flatMap(
            (f) => f.commits.map((c) => c.replace(/^[0-9a-f]+ /, "")),
          );
          out.push({
            id: task.id,
            title: task.title,
            text: [task.title, record?.done ?? "", record?.outcome ?? "", ...commits.slice(0, 20)]
              .filter((x) => x !== "")
              .join(". "),
          });
        }
        return out;
      },
      embed: (texts) => deps.memory.embed(texts),
      closeThread: (id, by, reason) => {
        deps.memory.project.closeThread(id, by, reason);
      },
    },

    // -------------------------------------------------------------------------
    // Memory

    async pendingFacts(org) {
      // The workspace's own scope and its projects'; Private's also the global one. Never another
      // workspace's.
      const { projects } = await deps.config.sections();
      return deps.memory
        .list({ status: "pending", scopes: laneScopes(org, projects), limit: PENDING_LIMIT })
        .map((f) => ({ id: f.id, text: f.text }));
    },

    async curate(_org, fact, off) {
      const before = deps.memory.get(fact.id);
      if (before === undefined || before.status !== "pending") return { outcome: "pending" };
      const { reason } = await deps.curate(before, off);
      const why = reason === undefined ? {} : { reason };
      const after = deps.memory.get(fact.id);
      const event = deps.memory.events({ fact: fact.id, limit: 1 })[0]?.id;
      if (after === undefined || after.status === "pending") return { outcome: "pending", ...why };
      const ev = event === undefined ? {} : { event };
      if (after.status === "active") return { outcome: "kept", ...ev, ...why };
      return { outcome: after.duplicate_of === undefined ? "dropped" : "merged", ...ev, ...why };
    },

    // -------------------------------------------------------------------------
    // Projects

    async newRepos(org) {
      const loaded = await deps.config.load();
      if (loaded.state.status !== "loaded") return [];
      const sections = await deps.config.sections();
      const name = (sections.orgs[org]?.name ?? (org === PRIVATE ? "private" : org)).toLowerCase();
      const scan = await deps.scanner.scan(
        {
          config: loaded.state.config,
          projectPaths: loaded.projectPaths,
          hostHome: deps.config.paths.hostHome,
        },
        true,
      );
      const taken = new Set(Object.keys(sections.projects));
      const out: NewRepo[] = [];
      for (const root of scan.roots) {
        for (const repo of root.repos) {
          if (repo.registered) continue;
          const parts = repo.relPath.split("/");
          const folder = parts[0]?.toLowerCase();
          if (parts.length !== 2 || (folder !== org && folder !== name)) continue;
          const slug = slugOf(repo.name);
          const id = [slug, `${org}-${slug}`].find((c) => c !== "" && !taken.has(c));
          const base = (await defaultBranch(repo.path)) ?? repo.branch ?? "main";
          out.push({
            path: repo.path,
            name: repo.name,
            id: id ?? slug,
            base,
            remotes: repo.remotes.map((r) => ({ name: r.name, url: r.url })),
            aliases: await deps.aliasesOf(repo.path, id ?? slug),
            ...(id === undefined ? { unsure: `The ids ${slug} and ${org}-${slug} are taken` } : {}),
          });
          if (id !== undefined) taken.add(id);
        }
      }
      return out;
    },

    async register(org, repo, reason) {
      const done = await run(
        "projects.register",
        { id: repo.id, org, path: repo.path, aliases: repo.aliases, base: repo.base },
        reason,
      );
      return done.commit === undefined ? {} : { commit: done.commit };
    },

    // -------------------------------------------------------------------------
    // Task triage

    triageTasks(org) {
      return tasksOf(org)
        .filter((t) => t.status === "inbox" || t.status === "ready")
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          ...(t.priority === undefined ? {} : { priority: t.priority }),
          ...(t.due === undefined ? {} : { due: t.due }),
          updatedAt: t.updatedAt,
          checklist: checklistItems(store.tasks.get(t.id)?.brief ?? ""),
        }));
    },

    async setPriority(_org, task, priority, reason) {
      await run("tasks.update", { id: task, priority }, reason, task);
    },

    // -------------------------------------------------------------------------
    // Cleanup

    async cleanable(org) {
      const days = (await deps.config.settings()).cleanup.after_days;
      const preview = await deps.cleanup.preview(days);
      return preview.tasks
        .filter((t) => orgOfTask(t.id) === org)
        .map((t) => ({
          id: t.id,
          title: t.title,
          steps: t.steps.filter((s) => s.action === "remove").map((s) => `${s.kind} ${s.name}`),
          dirty: t.steps
            .filter((s) => s.action === "skip" && s.reason?.startsWith("it has uncommitted") === true)
            .map((s) => `${s.name}: ${s.reason}`),
        }))
        .filter((t) => t.steps.length > 0 || t.dirty.length > 0);
    },

    async clean(_org, task) {
      const days = (await deps.config.settings()).cleanup.after_days;
      const report = await deps.cleanup.run([task], days, "captain");
      const steps = report.tasks[0]?.steps ?? [];
      return {
        removed: steps.filter((s) => s.action === "remove").map((s) => `${s.kind} ${s.name}`),
        kept: steps
          .filter((s) => s.action === "skip")
          .map((s) => `${s.kind} ${s.name} (${s.reason ?? "kept"})`),
      };
    },

    async foldersFreeable(org) {
      if (deps.folders === undefined) return { bytes: 0, tasks: 0 };
      const report = await deps.folders.preview(await sweepOptions(org));
      return { bytes: report.freedBytes, tasks: report.tasks.filter((t) => t.bytes > 0).length };
    },

    async freeFolders(org) {
      if (deps.folders === undefined) return { bytes: 0, tasks: [] };
      const report = await deps.folders.run(await sweepOptions(org));
      return {
        bytes: report.freedBytes,
        tasks: report.tasks
          .filter((t) => t.bytes > 0)
          .map((t) => ({
            id: t.id,
            bytes: t.bytes,
            worktrees: t.worktrees.length,
            folders: t.removed.length,
          })),
      };
    },

    // -------------------------------------------------------------------------
    // Stuck tasks

    stalled(org) {
      const out = [];
      for (const t of tasksOf(org)) {
        if (t.status !== "running" || deps.lanes.orgOf(t.id) !== undefined) continue;
        const lead = t.team[0];
        if (lead === undefined || !deps.idle.quiet(t.id) || pendingOwnerCards(t.id)) continue;
        const last = store.raw.prepare("SELECT MAX(at) AS at FROM turns WHERE task = ?").get(t.id) as {
          at: string | null;
        };
        out.push({ id: t.id, lead, quietSince: last.at ?? t.updatedAt });
      }
      return out;
    },

    wakeLead(_org, task) {
      const lead = store.tasks.get(task)?.team[0];
      if (lead === undefined) return;
      deps.room.post(task as TaskId, `captain:${randomUUID()}`, {
        type: "system",
        level: "info",
        text: `Nobody was working on ${task} and nothing was pending. The captain woke @${lead}.`,
      });
      deps.runs.notify(
        task,
        lead,
        [
          `Nobody is working on ${task} now and nothing is pending: no handoff, no question to the owner, no background process.`,
          'Hand off the next step of your plan (the majhi-room mention tool, or "@name: please ..."), finish the task, or say what it waits for.',
        ].join("\n"),
      );
    },

    async pauseForOwner(_org, task, text) {
      await deps.tasks.pauseForOwner(task, text, "blocked");
    },

    async signInStalls(org) {
      const out: SignInStall[] = [];
      const firstWorking = async (team: readonly string[], except: string) => {
        for (const a of team) {
          if (a !== except && (await deps.accounts.signedOutAccountOf(a)) === undefined) return a;
        }
        return undefined;
      };
      for (const t of tasksOf(org)) {
        if (deps.lanes.orgOf(t.id) !== undefined) continue;
        const lead = t.team[0];
        if (lead === undefined) continue;
        const quiet = t.status === "running" && deps.idle.quiet(t.id) && !pendingOwnerCards(t.id);
        const pausedSignedOut = t.status === "paused" && t.pausedReason === "signed-out";
        if (!quiet && !pausedSignedOut) continue;
        const leadAccount = await deps.accounts.signedOutAccountOf(lead);
        const failed = quiet ? deps.idle.failedSignIn(t.id) : undefined;
        const stuck =
          leadAccount !== undefined
            ? { agent: lead, account: leadAccount }
            : failed !== undefined && (await deps.accounts.needsLogin(failed.account))
              ? failed
              : undefined;
        if (stuck === undefined) continue;
        const since = (await deps.accounts.signedOutSince(stuck.account)) ?? t.updatedAt;
        const to = await firstWorking(t.team, stuck.agent);
        out.push({
          id: t.id,
          lead,
          agent: stuck.agent,
          account: stuck.account,
          since,
          ...(to === undefined ? {} : { to }),
        });
      }
      return out;
    },

    async moveLead(_org, task, to, reason) {
      const old = store.tasks.get(task)?.team[0] ?? "the old lead";
      await run("tasks.update", { id: task, agent: to }, reason, task);
      if (store.tasks.get(task)?.status === "paused") await run("tasks.start", { id: task }, reason, task);
      // The brief went to the old lead already: the new one is told what happened, which starts it.
      deps.runs.notify(
        task,
        to,
        `You lead ${task} now: @${old}'s account needs a new sign-in. Read TASK.md and the room (majhi-room read_recent), then go on with the plan.`,
      );
    },

    handBack(_org, task, agent, account) {
      const lead = store.tasks.get(task)?.team[0];
      if (lead === undefined) return;
      deps.room.post(task as TaskId, `captain:${randomUUID()}`, {
        type: "system",
        level: "info",
        text: `@${agent} cannot run: its account ${account} needs a new sign-in. The captain woke @${lead} to give its step to a teammate.`,
      });
      deps.runs.notify(
        task,
        lead,
        [
          `@${agent} cannot run: its account ${account} needs a new sign-in, so its step is not being done. Nobody is working on ${task} now.`,
          `Give its step to a teammate whose account works (the majhi-room mention tool, or "@name: please ..."). Do not hand anything to @${agent} until the owner signs it in again.`,
        ].join("\n"),
      );
    },

    typing(task) {
      return deps.typing(task);
    },
  };
}

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** The steps a brief lists: `- [ ]` and `- [x]` items. */
export function checklistItems(brief: string): number {
  return brief.split("\n").filter((l) => /^\s*[-*] \[[ xX]\]/.test(l)).length;
}
