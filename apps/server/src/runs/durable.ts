import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import { attributionOf } from "./attribution.ts";
import {
  type CheckpointRepo,
  commitBy,
  commitCheckpoint,
  DEFAULT_IDENTITY,
  diffStat,
  diffText,
  type Identity,
} from "./checkpoint.ts";
import { BUDGET, durableNote, roomLines, saveNote } from "./handoff.ts";
import type { Carry } from "./run.ts";

/**
 * What survives a session (SPEC 5.7, 5.13): checkpoint commits after each turn, and the note and
 * state a fresh session starts from.
 */
export interface DurableDeps {
  store: Store;
  room: RoomService;
  config: ConfigService;
}

const IDENTITY_HINT_ID = "hint:identity";

/** The task's worktrees, as checkpoints and diffs see them. */
export function checkpointRepos(task: Task): CheckpointRepo[] {
  return task.repos.flatMap((r) =>
    r.worktree === undefined
      ? []
      : [{ project: r.project, worktree: r.worktree, branch: r.branch, base: r.base }],
  );
}

async function identityFor(
  config: ConfigService,
  task: Task,
): Promise<{ identity: Identity; fallback: boolean; orgName: string }> {
  const org = (await config.sections()).orgs[task.org ?? "private"];
  const orgName = org?.name ?? "the org";
  return org?.identity === undefined
    ? { identity: DEFAULT_IDENTITY, fallback: true, orgName }
    : { identity: org.identity, fallback: false, orgName };
}

/**
 * Commits the task's changed worktrees as its next checkpoint and records it on the run, with the
 * room position, committed by `agent`. Says once per task where to set a commit identity. Returns warnings for the room.
 */
export async function checkpointTurn(
  deps: DurableDeps,
  task: Task,
  runId: number | undefined,
  agent?: string,
): Promise<string[]> {
  const { store, room, config } = deps;
  const on = await attributionOf(config, task);
  const repos = checkpointRepos(task).map((r) => ({ ...r, attribution: on.repos[r.project] !== false }));
  if (repos.length === 0) return [];
  const identity = await identityFor(config, task);
  const n = store.runs.lastCheckpoint(task.id).checkpoint + 1;
  const result = await commitCheckpoint(repos, task.id, n, commitBy(identity.identity, task.id, agent));
  const warnings = result.skipped.map((line) => `Checkpoint: ${line}`);
  if (result.committed.length === 0) return warnings;
  room.flush(task.id);
  const seq = store.room.page(task.id, 1).items[0]?.seq ?? 0;
  if (runId !== undefined) store.runs.setCheckpoint(runId, n, seq);
  if (identity.fallback && room.get(task.id, IDENTITY_HINT_ID) === undefined) {
    room.post(task.id, IDENTITY_HINT_ID, {
      type: "system",
      level: "info",
      text: `Commits are authored as ${DEFAULT_IDENTITY.name} <${DEFAULT_IDENTITY.email}>. To use your own name, set a commit identity for ${identity.orgName} in Orgs.`,
    });
  }
  return warnings;
}

/**
 * The note for a fresh session (the agent's, else one built from saved state), saved under
 * `.handoffs/`, and everything else the session's first prompt carries.
 */
export async function buildCarry(
  deps: DurableDeps,
  task: Task,
  agent: string,
  agentNote: string | undefined,
  why: string,
): Promise<{ carry: Carry; path: string }> {
  const { store, room } = deps;
  room.flush(task.id);
  const taskMd = await readFile(join(task.folder, "TASK.md"), "utf8").catch(() => "");
  const repos = checkpointRepos(task);
  const last = store.runs.lastCheckpoint(task.id);
  const recent = store.room.page(task.id, 300).items.filter((i) => i.type !== "context");
  const note =
    agentNote ??
    durableNote({
      task: task.id,
      agent,
      taskMd,
      checkpoint: last.checkpoint,
      room: recent.filter((i) => i.seq > last.roomSeq),
      diff: await diffText(repos, BUDGET.diff),
      why,
    });
  const path = await saveNote(task.folder, agent, note);
  return {
    carry: {
      taskMd,
      note,
      room: roomLines(recent.slice(0, 40), BUDGET.roomSummary, 300),
      diffStat: await diffStat(repos),
    },
    path,
  };
}
