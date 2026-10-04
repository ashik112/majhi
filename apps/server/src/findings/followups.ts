import type { Thread } from "@majhi/shared";
import type { ChoreRun } from "../captain/runner.ts";
import { cosine } from "../memory/embedder.ts";
import type { FindingsService } from "./service.ts";

/**
 * The follow-ups playbook (SPEC 5.18, Findings), run as the captain's `followups` chore. It reads the
 * open threads of memory for one workspace and, for each one, by rules first:
 * 1. its follow-up task is done: close it, saying where it was fixed;
 * 2. a task finished since says it was done (embedding similarity of the thread with the task's title,
 *    record and commits): close it, or when it is only close, ask the captain once for all of them;
 * 3. it repeats an older open thread: close it as a duplicate of that one;
 * 4. it is already a finding: refresh the finding;
 * 5. otherwise report a finding, and when it is concrete work, propose a task (inbox, not started).
 * No model turn is spent unless some follow-ups are ambiguous, and then it is one turn.
 */

/** Same thing: close or merge without asking. */
export const SAME_COSINE = 0.9;
/** Could be the same thing: the captain looks, once. */
export const MAYBE_COSINE = 0.72;
/** The most threads one run reads. */
const MAX_THREADS = 60;
/** The most ambiguous follow-ups one captain turn is asked about. */
const MAX_ASKED = 8;

/** A finished task, with what it says about its work. */
export interface DoneTask {
  id: string;
  title: string;
  /** Title, record and commit subjects, as text to compare. */
  text: string;
}

export interface FollowUpPorts {
  /** Open threads of the workspace, oldest first. */
  openThreads(org: string): Thread[];
  /** A task's title and status, undefined when it is gone. */
  task(id: string): { id: string; title: string; status: string } | undefined;
  /** Tasks of the workspace that finished after `since`, in the thread's project when it has one. */
  doneSince(org: string, project: string | undefined, since: string): Promise<DoneTask[]>;
  /** Unit vectors for the texts, undefined when the embedding model is not there. */
  embed(texts: readonly string[]): Promise<Float32Array[] | undefined>;
  closeThread(id: number, by: string, reason: string): void;
}

export interface FollowUpDeps {
  ports: FollowUpPorts;
  findings: FindingsService;
  /** One short captain turn in the workspace's lane. */
  askLane(org: string, text: string): Promise<{ sent: true } | { sent: false; why: string }>;
}

const HEDGES =
  /^(consider|maybe|perhaps|might|could|think about|look into whether|figure out if|decide whether|discuss|wonder)\b/i;

/** Work a task can be made from: a project, a few words, an action, not a question or a maybe. */
export function isConcrete(thread: Pick<Thread, "text" | "project">): boolean {
  const text = thread.text.trim();
  if (thread.project === undefined) return false;
  if (text.split(/\s+/).length < 4) return false;
  if (text.endsWith("?") || HEDGES.test(text)) return false;
  return true;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/** Share of words in common, the stand-in when no embedding model is there. */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / Math.min(x.size, y.size);
}

const clip = (s: string, n = 90) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}...`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();

export async function runFollowUps(run: ChoreRun, deps: FollowUpDeps): Promise<void> {
  const { ports, findings } = deps;
  const { org } = run;
  const threads = ports.openThreads(org).slice(0, MAX_THREADS);
  if (threads.length === 0) return;
  const known = findings.list({ status: "live", limit: 500 }, { kind: "captain", org }).findings;

  // Preflight, in code: when every thread is already a finding and none has a task of its own to
  // watch, nothing is new. The findings are refreshed and no embedding, task read or model turn is spent.
  const seenBefore = (t: Thread) => known.find((f) => f.dedupeKey === `followup:${t.id}`);
  if (threads.every((t) => t.follow_up === undefined && seenBefore(t) !== undefined)) {
    for (const t of threads) {
      const f = seenBefore(t);
      if (f === undefined) continue;
      await findings.report(
        {
          org,
          ...(f.project === undefined ? {} : { project: f.project }),
          source: f.source,
          title: f.title,
          detail: "",
          evidence: [],
          severity: f.severity,
          dedupeKey: f.dedupeKey,
        },
        { kind: "captain", org },
      );
    }
    return;
  }

  // Later work to compare with, read once per project.
  const doneByProject = new Map<string, DoneTask[]>();
  const oldest = threads.reduce(
    (a, t) => (t.created_at < a ? t.created_at : a),
    threads[0]?.created_at ?? "",
  );
  const finished = async (project: string | undefined) => {
    const key = project ?? "";
    const cached = doneByProject.get(key);
    if (cached !== undefined) return cached;
    const read = await ports.doneSince(org, project, oldest);
    doneByProject.set(key, read);
    return read;
  };
  for (const t of threads) await finished(t.project);

  // One embedding call for every text.
  const texts: string[] = threads.map((t) => one(t.text));
  const doneTexts: string[] = [];
  for (const list of doneByProject.values()) for (const d of list) doneTexts.push(one(d.text));
  const vectors = await ports.embed([...texts, ...doneTexts]);
  const vectorOf = new Map<string, Float32Array>();
  [...texts, ...doneTexts].forEach((text, i) => {
    const v = vectors?.[i];
    if (v !== undefined) vectorOf.set(text, v);
  });
  const similar = (a: string, b: string): number => {
    const x = vectorOf.get(one(a));
    const y = vectorOf.get(one(b));
    return x !== undefined && y !== undefined ? cosine(x, y) : overlap(a, b);
  };

  const closed = new Set<number>();
  const ambiguous: { thread: Thread; task: DoneTask }[] = [];

  for (const [index, t] of threads.entries()) {
    run.check();
    const words80 = clip(one(t.text), 80);

    // 1. The task made for it is done.
    if (t.follow_up !== undefined) {
      const made = ports.task(t.follow_up);
      if (made?.status === "done") {
        await run.act({
          key: `followup:${t.id}:close`,
          text: `Closed follow-up: ${words80} (fixed in ${made.id})`,
          reason: `Its task ${made.id} is done`,
          do: async () => {
            ports.closeThread(t.id, `follow-up:${made.id}`, `Done in ${made.id}.`);
            return {};
          },
        });
        closed.add(t.id);
        continue;
      }
      // A task for it is going on: nothing to add.
      if (made !== undefined) continue;
    }

    // 2. A task finished since says it was done.
    const later = (await finished(t.project)).filter((d) => d.id !== t.task && d.id !== t.follow_up);
    let best: { task: DoneTask; score: number } | undefined;
    for (const d of later) {
      const score = similar(t.text, d.text);
      if (best === undefined || score > best.score) best = { task: d, score };
    }
    if (best !== undefined && best.score >= SAME_COSINE) {
      const fixed = best.task;
      await run.act({
        key: `followup:${t.id}:close`,
        text: `Closed follow-up: ${words80} (fixed in ${fixed.id})`,
        reason: `${fixed.id} (${clip(fixed.title, 60)}) did this`,
        evidence: `${Math.round(best.score * 100)}% alike`,
        do: async () => {
          ports.closeThread(t.id, `task:${fixed.id}`, `Done in ${fixed.id}.`);
          return {};
        },
      });
      closed.add(t.id);
      continue;
    }
    const maybe = best !== undefined && best.score >= MAYBE_COSINE ? best.task : undefined;

    // 3. It repeats an older open thread of the same project.
    const twin = threads
      .slice(0, index)
      .find((u) => !closed.has(u.id) && u.project === t.project && similar(t.text, u.text) >= SAME_COSINE);
    if (twin !== undefined) {
      await run.act({
        key: `followup:${t.id}:close`,
        text: `Merged follow-up: ${words80} (same as #${twin.id})`,
        reason: "It says what an older open follow-up already says",
        do: async () => {
          ports.closeThread(t.id, "captain", `Same as follow-up #${twin.id}.`);
          return {};
        },
      });
      closed.add(t.id);
      continue;
    }

    // 4 and 5. A finding, refreshed or new.
    const key = `followup:${t.id}`;
    const title = clip(one(t.text), 160);
    const evidence = [
      `Left open by ${t.task}`,
      ...(maybe === undefined ? [] : [`May be done in ${maybe.id}`]),
    ];
    const detail = [
      t.text.trim(),
      ...(maybe === undefined ? [] : ["", `A later task, ${maybe.id} (${maybe.title}), may have done this.`]),
    ].join("\n");
    const existing = known.find((f) => f.dedupeKey === key);
    if (existing !== undefined) {
      await findings.report(
        {
          org,
          ...(t.project === undefined ? {} : { project: t.project }),
          source: "follow-up",
          title,
          detail,
          evidence,
          severity: "info",
          dedupeKey: key,
        },
        { kind: "captain", org },
      );
      continue;
    }
    // The same matter reported by another playbook or agent: refresh that one instead of a second.
    const near = known.find((f) => f.project === t.project && similar(f.title, t.text) >= SAME_COSINE);
    if (near !== undefined) {
      await findings.report(
        {
          org,
          ...(near.project === undefined ? {} : { project: near.project }),
          source: near.source,
          title: near.title,
          detail: "",
          evidence,
          severity: near.severity,
          dedupeKey: near.dedupeKey,
        },
        { kind: "captain", org },
      );
      continue;
    }
    const concrete = maybe === undefined && isConcrete(t);
    if (maybe !== undefined) ambiguous.push({ thread: t, task: maybe });
    await run.act({
      key: `followup:${t.id}:report`,
      text: concrete ? `Proposed task: ${clip(one(t.text), 100)}` : `Noted a follow-up: ${words80}`,
      reason: concrete
        ? "An open follow-up that is concrete work; it waits in the inbox for you"
        : "An open follow-up with no task",
      do: async () => {
        const { finding } = await findings.report(
          {
            org,
            ...(t.project === undefined ? {} : { project: t.project }),
            source: "follow-up",
            title,
            detail,
            evidence,
            severity: "info",
            playbook: "upkeep-followups",
            dedupeKey: key,
          },
          { kind: "captain", org },
        );
        known.push(finding);
        if (!concrete) return {};
        const made = await findings.toTask(finding.id, { kind: "captain", org });
        return { text: `Proposed task: ${clip(one(t.text), 100)} (${made.task})` };
      },
    });
  }

  // One captain turn for all the follow-ups that may already be done.
  if (ambiguous.length > 0) {
    run.check();
    const list = ambiguous.slice(0, MAX_ASKED);
    const lines = list.map(
      ({ thread, task }) =>
        `- Follow-up #${thread.id}: "${clip(one(thread.text), 120)}" may be done in ${task.id} (${clip(task.title, 80)})`,
    );
    const prompt = [
      "Follow-ups that may already be done. Check each against the task and the code.",
      "If it is done, close it with majhi_memory_closeThread and a reason. If not, leave it.",
      ...lines,
    ].join("\n");
    await run.act({
      key: `followup:ask:${list.map((a) => a.thread.id).join(",")}`,
      text: `Asked the captain about ${list.length} follow-up${list.length === 1 ? "" : "s"} that may be done`,
      reason: "The rules could not tell if later work did them",
      do: async () => {
        const sent = await deps.askLane(org, prompt);
        return sent.sent ? {} : { text: `Left ${list.length} follow-ups for later: ${sent.why}` };
      },
    });
  }
}
