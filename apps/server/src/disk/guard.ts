import type { MachineReading } from "@majhi/shared";
import type { ContainerService } from "../containers/service.ts";
import {
  type SweepOptions,
  type SweepReport,
  sizeText,
  type TaskFolderSweep,
} from "../tasks/folder-sweep.ts";

/**
 * The owner's disk (SPEC 5.18, Tidy). Free space under 15% or under 30 GB is low. Tidy then frees what
 * is safe at once, and when the disk stays low, the owner gets one card with the biggest consumers and a
 * one-click action that lists exactly what goes. The Docker build cache is never touched, by this or
 * anything else: builds stay fast.
 */

export const LOW_FREE_PCT = 15;
export const LOW_FREE_BYTES = 30_000_000_000;

/** The disk is low when under 15% is free or under 30 GB. */
export function isDiskLow(freeBytes: number, totalBytes: number | undefined): boolean {
  if (freeBytes < LOW_FREE_BYTES) return true;
  return totalBytes !== undefined && totalBytes > 0 && (freeBytes / totalBytes) * 100 < LOW_FREE_PCT;
}

export interface DiskReading {
  freeBytes: number;
  totalBytes: number | undefined;
  low: boolean;
}

/** What one-click would remove, exactly. */
export interface DiskPlan {
  bytes: number;
  /** One line per kind of thing, with its size, for the card. */
  lines: string[];
}

export interface DockerFreeable {
  images: number;
  volumes: number;
  bytes: number;
}

/** Everything that may go, whatever its age: the aggressive pass behind the owner's one click. */
const ANY_AGE: SweepOptions = { hours: 0, worktreeDays: 0.001, idleDays: 0.001 };
/** The age of Docker leftovers that go in the aggressive pass. */
const ANY_DOCKER_AGE_DAYS = 0.001;

const PLAN_EVERY_MS = 10 * 60_000;
const USAGE_EVERY_MS = 30 * 60_000;

export interface DiskGuardDeps {
  machine: () => MachineReading | undefined;
  sweep: TaskFolderSweep;
  containers: ContainerService;
  now?: () => Date;
}

/** What majhi itself holds, for the dashboard. */
export interface DiskUsage {
  tasksBytes: number;
  dockerBytes: number | undefined;
}

export class DiskGuard {
  private plan_: { at: number; value: DiskPlan } | undefined;
  private planning: Promise<void> | undefined;
  private usage_: { at: number; value: DiskUsage } | undefined;
  private measuring: Promise<void> | undefined;

  constructor(private readonly deps: DiskGuardDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The disk as the host helper last read it, or undefined while it is not connected. */
  reading(): DiskReading | undefined {
    const host = this.deps.machine()?.host;
    if (host?.diskFreeBytes === undefined) return undefined;
    return {
      freeBytes: host.diskFreeBytes,
      totalBytes: host.diskTotalBytes,
      low: isDiskLow(host.diskFreeBytes, host.diskTotalBytes),
    };
  }

  /** Old unused images and old volumes of done tasks that the routine prune would remove. */
  async docker(): Promise<DockerFreeable> {
    const now = this.now();
    const images = await this.deps.containers.unusedImages(now);
    const volumes = await this.deps.containers.staleVolumes(now);
    return { images: images.length, volumes: volumes.length, bytes: images.reduce((n, i) => n + i.bytes, 0) };
  }

  /** The routine prune: images unused for a week, volumes of tasks done for a week. */
  async freeDocker(): Promise<DockerFreeable> {
    const now = this.now();
    const images = await this.deps.containers.removeUnusedImages(
      await this.deps.containers.unusedImages(now),
    );
    const volumes = await this.deps.containers.pruneVolumes(now);
    this.usage_ = undefined;
    return { images: images.removed, volumes, bytes: images.bytes };
  }

  /** What the one click removes, measured now. */
  async plan(): Promise<DiskPlan> {
    const now = this.now();
    const sweep = await this.deps.sweep.preview(ANY_AGE);
    const images = await this.deps.containers.unusedImages(now, ANY_DOCKER_AGE_DAYS);
    const volumes = await this.deps.containers.staleVolumes(now, ANY_DOCKER_AGE_DAYS);
    return describePlan(
      sweep,
      images.length,
      images.reduce((n, i) => n + i.bytes, 0),
      volumes.length,
    );
  }

  /**
   * The last plan, for Health, which reads often. A stale or missing one starts a new measurement in
   * the background; undefined until the first finishes.
   */
  planSnapshot(): DiskPlan | undefined {
    const stale = this.plan_ === undefined || this.now().getTime() - this.plan_.at > PLAN_EVERY_MS;
    if (stale && this.planning === undefined) {
      this.planning = this.plan().then(
        (value) => {
          this.plan_ = { at: this.now().getTime(), value };
          this.planning = undefined;
        },
        () => {
          this.planning = undefined;
        },
      );
    }
    return this.plan_?.value;
  }

  /** Does the one click: the same list `plan` shows, nothing else. Returns what it freed. */
  async freeNow(): Promise<{ bytes: number; text: string }> {
    const now = this.now();
    const sweep = await this.deps.sweep.run(ANY_AGE);
    const images = await this.deps.containers.removeUnusedImages(
      await this.deps.containers.unusedImages(now, ANY_DOCKER_AGE_DAYS),
    );
    const volumes = await this.deps.containers.pruneVolumes(now, ANY_DOCKER_AGE_DAYS);
    this.plan_ = undefined;
    this.usage_ = undefined;
    const done = describePlan(sweep, images.removed, images.bytes, volumes);
    return {
      bytes: done.bytes,
      text:
        done.bytes === 0 && done.lines.length === 0
          ? "Nothing to free."
          : `Freed about ${sizeText(done.bytes)}: ${done.lines.join("; ")}.`,
    };
  }

  /** What majhi holds on the disk, measured at most every half hour. Undefined until the first measure ends. */
  usage(): DiskUsage | undefined {
    const stale = this.usage_ === undefined || this.now().getTime() - this.usage_.at > USAGE_EVERY_MS;
    if (stale && this.measuring === undefined) {
      this.measuring = this.measure().then(
        (value) => {
          this.usage_ = { at: this.now().getTime(), value };
          this.measuring = undefined;
        },
        () => {
          this.measuring = undefined;
        },
      );
    }
    return this.usage_?.value;
  }

  private async measure(): Promise<DiskUsage> {
    const tasks = this.deps.sweep.snapshot();
    const docker = await this.deps.containers.usage();
    return {
      tasksBytes: tasks?.rootBytes ?? 0,
      dockerBytes:
        docker === undefined
          ? undefined
          : docker.imagesBytes + docker.volumesBytes + docker.cacheBytes + docker.containersBytes,
    };
  }

  /** The biggest things on the disk that majhi holds, largest first, for the card. */
  async consumers(): Promise<string[]> {
    const tasks = this.deps.sweep.snapshot();
    const docker = await this.deps.containers.usage();
    const rows: { what: string; bytes: number }[] = [
      ...(tasks === undefined ? [] : [{ what: "Task folders", bytes: tasks.rootBytes }]),
      ...(docker === undefined
        ? []
        : [
            { what: "Docker images", bytes: docker.imagesBytes },
            { what: "Docker volumes (task service data)", bytes: docker.volumesBytes },
            { what: "Docker build cache (kept: builds stay fast)", bytes: docker.cacheBytes },
          ]),
    ];
    return rows.toSorted((a, b) => b.bytes - a.bytes).map((r) => `${r.what} ${sizeText(r.bytes)}`);
  }
}

/** The lines of a plan or of what a pass did. */
export function describePlan(
  sweep: SweepReport,
  images: number,
  imageBytes: number,
  volumes: number,
): DiskPlan {
  const lines: string[] = [];
  const sum = (tasks: SweepReport["tasks"]) => tasks.reduce((n, t) => n + t.bytes, 0);
  const done = sweep.tasks.filter((t) => t.mode === "done" && t.bytes > 0);
  const idle = sweep.tasks.filter((t) => t.mode === "idle" && t.bytes > 0);
  const trees = done.reduce((n, t) => n + t.worktrees.length, 0);
  if (done.length > 0) {
    lines.push(
      `dependencies and build output of ${done.length} done ${done.length === 1 ? "task" : "tasks"}${
        trees > 0
          ? `, and ${trees} clean ${trees === 1 ? "worktree" : "worktrees"} whose branch is merged or pushed`
          : ""
      } (${sizeText(sum(done))})`,
    );
  }
  if (idle.length > 0) {
    lines.push(
      `node_modules of ${idle.length} ${idle.length === 1 ? "task" : "tasks"} in review or paused (${sizeText(sum(idle))}, back with the next install)`,
    );
  }
  if (images > 0)
    lines.push(`${images} unused Docker ${images === 1 ? "image" : "images"} (${sizeText(imageBytes)})`);
  if (volumes > 0) lines.push(`${volumes} ${volumes === 1 ? "volume" : "volumes"} of done tasks`);
  return { bytes: sweep.freedBytes + imageBytes, lines };
}
