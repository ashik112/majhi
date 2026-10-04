import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";
import type { OpsWatch } from "./watch.ts";

const run = promisify(execFile);

/**
 * majhi watching itself (SPEC 5.18): measurements that are not Health checks yet (event-loop lag,
 * memory, free disk under ~/.majhi and the backup folder, the size and growth of the database, a
 * stuck queue, the task worktrees' size, Laya), joined with Health's own checks. A failing one is an
 * incident in the Private workspace; where Health has a fix, the incident carries its button.
 */

const GB = 1_000_000_000;
const MB = 1_000_000;

export interface SelfCheck {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: { label: string } | undefined;
  severity: "high" | "medium";
}

/** The Health checks whose failure is urgent. The rest are medium. */
const HIGH_HEALTH = new Set([
  "disk",
  "host-helper",
  "backups",
  "secrets-key",
  "runner",
  "config",
  "config-folder",
]);

export const LIMITS = {
  /** Event loop p99 delay, ms. */
  lagFailMs: 5_000,
  /** Resident memory as a share of the machine's. */
  memoryFail: 0.6,
  /** Docker stops well before the disk is empty (it died at about 6 GB free once), so warn early. */
  diskWarnBytes: 20 * GB,
  diskFailBytes: 8 * GB,
  dbFailBytes: 8 * GB,
  /** Growth of the database in 24 hours. */
  dbGrowthFailBytes: 1 * GB,
  queueStuckMin: 30,
  worktreesFailBytes: 60 * GB,
  e2eFailBytes: 10 * GB,
} as const;

export interface HealthLike {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: { label: string } | undefined;
}

export interface SelfDeps {
  /** Health's checks (`HealthService.checks`). */
  health: () => Promise<HealthLike[]>;
  /** Folders whose free space matters: majhi's own, and where backups go. */
  disks: () => Promise<{ label: string; path: string }[]>;
  dbPath: () => string;
  /** Folders whose size matters, by label. */
  trees: () => Promise<{ id: string; label: string; path: string; failBytes: number }[]>;
  /** Minutes the autonomous queue has had ready work without a tick; undefined when it is fine. */
  queueStall: () => number | undefined;
  /** Laya's state, when it is configured. */
  laya?: () => Promise<{ state: string; detail: string } | undefined>;
  /** Event loop p99 since the last read, in ms. */
  lagMs: () => number;
  memory: () => { rss: number; total: number };
  /** Reads and writes small facts that outlive a restart (the database size a day ago). */
  recall: { get(key: string): string | undefined; set(key: string, value: string): void };
  now: () => Date;
  freeBytes?: (path: string) => Promise<number>;
  sizeOf?: (path: string) => Promise<number | undefined>;
}

/** Event-loop delay as a histogram that resets each time it is read. */
export function eventLoopLag(): () => number {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  return () => {
    const p99 = h.percentile(99) / 1e6;
    h.reset();
    return Number.isFinite(p99) ? p99 : 0;
  };
}

async function realFree(path: string): Promise<number> {
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const fs = await statfs(probe);
  return fs.bavail * fs.bsize;
}

/** `du -sk`, which counts blocks like the disk does. Undefined when it cannot say. */
async function realSize(path: string): Promise<number | undefined> {
  try {
    if (!existsSync(path)) return 0;
    const { stdout } = await run("du", ["-sk", path], { timeout: 90_000 });
    const kb = Number(stdout.split(/\s/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

const TREE_EVERY_MS = 60 * 60_000;

export class SelfChecks {
  private trees = new Map<string, { at: number; bytes: number | undefined }>();

  constructor(private readonly deps: SelfDeps) {}

  /** The measurements of this process and machine. Each one reports itself failing or passing; none throws. */
  async measure(): Promise<SelfCheck[]> {
    const { deps } = this;
    const out: SelfCheck[] = [];
    const lag = deps.lagMs();
    out.push({
      id: "self-event-loop",
      name: "Server responsiveness",
      status: lag > LIMITS.lagFailMs ? "fail" : "pass",
      detail:
        lag > LIMITS.lagFailMs
          ? `The server stalled for up to ${(lag / 1000).toFixed(1)} s at a time. Restart majhi if it keeps happening.`
          : `Event loop delay ${Math.round(lag)} ms`,
      severity: "high",
    });
    const mem = deps.memory();
    const share = mem.total > 0 ? mem.rss / mem.total : 0;
    out.push({
      id: "self-memory",
      name: "Server memory",
      status: share > LIMITS.memoryFail ? "fail" : "pass",
      detail: `majhi uses ${(mem.rss / GB).toFixed(1)} GB of ${(mem.total / GB).toFixed(0)} GB${share > LIMITS.memoryFail ? ". Restart majhi to free it." : ""}`,
      severity: "medium",
    });
    for (const d of await deps.disks().catch(() => [])) {
      try {
        const free = await (deps.freeBytes ?? realFree)(d.path);
        const bad = free < LIMITS.diskFailBytes;
        const low = free < LIMITS.diskWarnBytes;
        out.push({
          id: `self-disk-${d.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name: `Free space for ${d.label}`,
          status: bad ? "fail" : low ? "warn" : "pass",
          detail: `${(free / GB).toFixed(1)} GB free${bad ? ". Docker and majhi stop when the disk fills. Free space on that disk now." : low ? ". Getting low: Docker stops when the disk fills." : ""}`,
          severity: "high",
        });
      } catch {
        // A disk majhi cannot measure says nothing.
      }
    }
    const dbSize = await (deps.sizeOf ?? stat2)(deps.dbPath());
    if (dbSize !== undefined) {
      const day = deps.now().toISOString().slice(0, 10);
      const yesterday = new Date(deps.now().getTime() - 86_400_000).toISOString().slice(0, 10);
      const before = Number(deps.recall.get(`db-size:${yesterday}`) ?? Number.NaN);
      deps.recall.set(`db-size:${day}`, String(dbSize));
      const growth = Number.isFinite(before) ? dbSize - before : 0;
      const bad = dbSize > LIMITS.dbFailBytes || growth > LIMITS.dbGrowthFailBytes;
      out.push({
        id: "self-db-size",
        name: "Database size",
        status: bad ? "fail" : "pass",
        detail: `${(dbSize / MB).toFixed(0)} MB${growth > 0 ? `, ${(growth / MB).toFixed(0)} MB more than yesterday` : ""}${bad ? ". It is growing faster than it should." : ""}`,
        severity: "medium",
      });
    }
    const stall = deps.queueStall();
    out.push({
      id: "self-queue",
      name: "Autonomous queue",
      status: stall !== undefined && stall > LIMITS.queueStuckMin ? "fail" : "pass",
      detail:
        stall !== undefined && stall > LIMITS.queueStuckMin
          ? `Work has waited ${Math.round(stall)} minutes with no step taken.`
          : "Moving",
      severity: "high",
    });
    for (const t of await deps.trees().catch(() => [])) {
      const bytes = await this.treeSize(t.path);
      if (bytes === undefined) continue;
      const bad = bytes > t.failBytes;
      out.push({
        id: t.id,
        name: t.label,
        status: bad ? "fail" : "pass",
        detail: `${(bytes / GB).toFixed(1)} GB${bad ? ". Delete finished tasks to free the disk." : ""}`,
        severity: "medium",
      });
    }
    const laya = await deps.laya?.().catch(() => undefined);
    if (laya !== undefined) {
      out.push({
        id: "self-laya",
        name: "Laya",
        status: laya.state === "error" ? "fail" : "pass",
        detail: laya.detail,
        severity: "medium",
      });
    }
    return out;
  }

  /** A folder's size is asked at most once an hour: `du` over many worktrees is not free. */
  private async treeSize(path: string): Promise<number | undefined> {
    const known = this.trees.get(path);
    const now = this.deps.now().getTime();
    if (known !== undefined && now - known.at < TREE_EVERY_MS) return known.bytes;
    const bytes = await (this.deps.sizeOf ?? realSize)(path);
    this.trees.set(path, { at: now, bytes });
    return bytes;
  }

  /** Health's checks and the measurements together, as the watch reads them. */
  async all(): Promise<SelfCheck[]> {
    const [health, own] = await Promise.all([
      this.deps.health().catch((): HealthLike[] => []),
      this.measure(),
    ]);
    return [
      ...health.map(
        (h): SelfCheck => ({
          ...h,
          id: h.id,
          severity: HIGH_HEALTH.has(h.id) ? "high" : "medium",
        }),
      ),
      ...own,
    ];
  }
}

async function stat2(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/** Runs the pass every few minutes and once soon after start. The timer never keeps the process alive. */
export function startSelfWatch(watch: OpsWatch, checks: SelfChecks, everyMs = 5 * 60_000): () => void {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      await watch.watchSelf(await checks.all());
    } catch (err) {
      console.error(`Self-watch failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void pass(), 90_000);
  const timer = setInterval(() => void pass(), everyMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
