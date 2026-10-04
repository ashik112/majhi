/**
 * Realistic volume for measuring the Captain page's reads (`MAJHI_E2E_SEED=perf`, see e2e/start-server.ts,
 * and the budget test in autonomy/perf.test.ts):
 * hundreds of tasks across four workspaces, thousands of room items, turns, decisions, captain
 * actions, autonomy events and findings. Written straight into majhi.db before the server starts.
 * Sample names only.
 */
import { CAPTAIN_LANE_BRIEF } from "@majhi/shared";
import type Database from "better-sqlite3";

export interface PerfVolume {
  tasksPerOrg: number;
  roomItemsPerTask: number;
  turns: number;
  decisions: number;
  captainActions: number;
  autonomyEvents: number;
  findings: number;
}

export const PERF_VOLUME: PerfVolume = {
  tasksPerOrg: 120,
  roomItemsPerTask: 30,
  turns: 8000,
  decisions: 5000,
  captainActions: 6000,
  autonomyEvents: 6000,
  findings: 2000,
};

const ORGS = [
  { key: "PRV", org: null, agent: "dispatcher" },
  { key: "GLX", org: "globex", agent: "globex-builder" },
  { key: "ACM", org: "acme", agent: "acme-builder" },
  { key: "NWD", org: "northwind", agent: "northwind-builder" },
] as const;
const STATUSES = ["inbox", "ready", "running", "paused", "review", "done", "done", "done"] as const;
const OUTCOMES = ["done", "done", "done", "asked", "skipped", "failed"] as const;
const CHORES = ["memory", "cleanup", "triage", "digest"] as const;

export function seedPerfVolume(sqlite: Database.Database, volume: PerfVolume = PERF_VOLUME): void {
  const now = Date.now();
  const iso = (agoMin: number) => new Date(now - agoMin * 60_000).toISOString();
  const day = (agoMin: number) => iso(agoMin).slice(0, 10);
  const tx = sqlite.transaction(() => {
    const task = sqlite.prepare(
      `INSERT INTO tasks (id, title, brief, kind, org, status, paused_reason, folder, team, created_at, updated_at)
       VALUES (?, ?, ?, 'code', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const repo = sqlite.prepare(
      `INSERT INTO task_repos (task, project, source, base, branch, worktree, created_branch, pos)
       VALUES (?, ?, 'owner', 'main', ?, NULL, 1, 0)`,
    );
    const auto = sqlite.prepare("INSERT INTO autonomy_tasks (task, since) VALUES (?, ?)");
    const item = sqlite.prepare(
      "INSERT INTO room_items (task, id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const counter = sqlite.prepare("INSERT OR REPLACE INTO task_counters (prefix, last) VALUES (?, ?)");
    for (const o of ORGS) {
      counter.run(o.key, volume.tasksPerOrg);
      for (let n = 1; n <= volume.tasksPerOrg; n++) {
        const id = `${o.key}-${n}`;
        const status = STATUSES[n % STATUSES.length] ?? "inbox";
        const age = (volume.tasksPerOrg - n) * 90 + 5;
        task.run(
          id,
          `Sample task ${n} for ${o.key}`,
          `Brief for sample task ${n}. `.repeat(8),
          o.org,
          status,
          status === "paused" ? "owner" : null,
          `/Users/owner/Work/${o.key.toLowerCase()}-api`,
          JSON.stringify([o.agent]),
          iso(age + 600),
          iso(age),
        );
        repo.run(id, `${o.key.toLowerCase()}-api`, `majhi/${id.toLowerCase()}`);
        if (n % 3 !== 0) auto.run(id, iso(age + 300));
        for (let s = 1; s <= volume.roomItemsPerTask; s++) {
          const pending = status !== "done" && s === volume.roomItemsPerTask && n % 4 === 0;
          const payload = pending
            ? {
                type: "approval",
                agent: o.agent,
                command: "projects.add",
                risk: "change",
                summary: `Add project sample-${n}`,
                input: "{}",
                state: "pending",
              }
            : { type: "message", from: o.agent, text: `Line ${s} of the room.`, state: "applied" };
          item.run(id, `i${s}`, s, pending ? "approval" : "message", JSON.stringify(payload), iso(age - s));
        }
      }
    }
    // One lane chat per workspace, with some chores run today.
    const lane = sqlite.prepare("INSERT INTO captain_lanes (org, chat, created_at) VALUES (?, ?, ?)");
    const run = sqlite.prepare(
      `INSERT INTO captain_runs (org, chore, day, started_at, ended_at, status, trigger, actions, tokens)
       VALUES (?, ?, ?, ?, ?, 'done', 'schedule', 3, 1200)`,
    );
    for (const o of ORGS) {
      const id = `${o.key}-${volume.tasksPerOrg + 1}`;
      counter.run(o.key, volume.tasksPerOrg + 1);
      task.run(
        id,
        "Captain",
        CAPTAIN_LANE_BRIEF,
        o.org,
        "running",
        null,
        "/Users/owner",
        JSON.stringify([]),
        iso(9000),
        iso(1),
      );
      sqlite.prepare("UPDATE tasks SET kind = 'chat' WHERE id = ?").run(id);
      lane.run(o.org ?? "private", id, iso(9000));
      for (let r = 0; r < 200; r++)
        run.run(o.org ?? "private", CHORES[r % CHORES.length], day(r * 60), iso(r * 60), iso(r * 60 - 1));
    }
    const turn = sqlite.prepare(
      `INSERT INTO turns (at, task, agent, account, tool, auth, org, project, model, input_tokens, output_tokens,
         reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_source, estimated)
       VALUES (?, ?, ?, ?, 'claude', 'login', ?, ?, 'sonnet-5.5', 4000, 900, 0, 20000, 1000, 0.31, 'reported', 0)`,
    );
    for (let i = 0; i < volume.turns; i++) {
      const o = ORGS[i % ORGS.length];
      if (o === undefined) continue;
      const n = (i % volume.tasksPerOrg) + 1;
      turn.run(
        iso(i * 5),
        `${o.key}-${n}`,
        o.agent,
        `claude-${o.org ?? "personal"}`,
        o.org,
        `${o.key.toLowerCase()}-api`,
      );
    }
    const decision = sqlite.prepare(
      `INSERT INTO decisions (id, at, use, task, agent, summary, provider, answers, estimated, duration_ms)
       VALUES (?, ?, 'pick-model', ?, NULL, 'Picked a model', 'rules', '{}', 0, 3.2)`,
    );
    for (let i = 0; i < volume.decisions; i++)
      decision.run(`d${i}`, iso(i * 6), `GLX-${(i % volume.tasksPerOrg) + 1}`);
    const action = sqlite.prepare(
      `INSERT INTO captain_actions (key, org, chore, day, at, text, reason, task, outcome)
       VALUES (?, ?, ?, ?, ?, 'Did a sample thing', 'Because the sample needed it', ?, ?)`,
    );
    for (let i = 0; i < volume.captainActions; i++) {
      const o = ORGS[i % ORGS.length];
      if (o === undefined) continue;
      action.run(
        `k${i}`,
        o.org ?? "private",
        CHORES[i % CHORES.length],
        day(i * 4),
        iso(i * 4),
        `${o.key}-${(i % volume.tasksPerOrg) + 1}`,
        OUTCOMES[i % OUTCOMES.length],
      );
    }
    const ev = sqlite.prepare(
      "INSERT INTO autonomy_events (at, kind, text, task, org) VALUES (?, 'picked', 'Picked a task', ?, ?)",
    );
    for (let i = 0; i < volume.autonomyEvents; i++) {
      const o = ORGS[i % ORGS.length];
      if (o === undefined) continue;
      ev.run(iso(i * 5), `${o.key}-${(i % volume.tasksPerOrg) + 1}`, o.org);
    }
    const finding = sqlite.prepare(
      `INSERT INTO findings (org, source, title, dedupe_key, status, by, created_at, updated_at, last_seen)
       VALUES (?, 'playbook', ?, ?, ?, 'captain', ?, ?, ?)`,
    );
    for (let i = 0; i < volume.findings; i++) {
      const o = ORGS[i % ORGS.length];
      if (o === undefined) continue;
      const at = iso(i * 10);
      finding.run(
        o.org ?? "private",
        `Sample finding ${i}`,
        `f${i}`,
        i % 5 === 0 ? "open" : "dismissed",
        at,
        at,
        at,
      );
    }
  });
  tx();
}
