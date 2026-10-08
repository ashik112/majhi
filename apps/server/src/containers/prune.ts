import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../errors.ts";
import { writeFileAtomic } from "../fs.ts";
import type { DockerResult } from "./docker.ts";

/**
 * Frees Docker disk without clearing the build cache (the owner's rule: builds stay fast). Three
 * things go: majhi's own preview images (label `majhi.container=image`) that no container uses and
 * nobody built or tagged for a week, the volumes of tasks done for a week, and the week-old cache of
 * a task builder (`pruneBuilderCache`). Nothing majhi did not label or name: other projects' images,
 * volumes and containers are never touched. `DockerCli.exec` allows no other prune.
 */

export const PRUNE_AGE_DAYS = 7;
/** How often the weekly prune runs on its own. The captain's tidy chore runs the same prune daily. */
export const PRUNE_EVERY_MS = 7 * 86_400_000;

/** The label every image majhi builds carries (`buildArgs`). */
const IMAGE_LABEL = "majhi.container=image";

/** The docker calls the prune makes: reads and removals only. */
export type PruneDocker = { exec(args: readonly string[]): Promise<DockerResult> };

/** An image as `image inspect` shows it. `at` is when it was built, pulled or tagged last. */
export interface ImageRow {
  id: string;
  at: string;
  bytes: number;
  refs: string[];
  /** The value of `majhi.container`, empty when the image has no such label. */
  label: string;
  /** The task that built it (`majhi.task`), empty when unknown. */
  task: string;
}

/** A task's named volume. */
export interface VolumeRow {
  name: string;
  task: string;
}

const lines = (out: DockerResult): string[] =>
  out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** `sha256:<hex>` as the bare hex, the form `DockerCli.exec` accepts for a removal. */
const bareId = (id: string): string => id.replace(/^sha256:/, "");

/** Docker prints a tag time it never set as the year 1. */
const NEVER = /^0001-/;

/**
 * The images to remove. Pure, so the choice is tested without docker. Only majhi's own preview images
 * (label `majhi.container=image`) go, when no container uses them and they were built or tagged
 * before `now - days`. `skipTasks` are tasks whose images stay at any age.
 */
export function selectUnusedImages(
  images: readonly ImageRow[],
  used: ReadonlySet<string>,
  now: Date,
  days: number = PRUNE_AGE_DAYS,
  skipTasks: ReadonlySet<string> = new Set(),
): ImageRow[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return images.filter((image) => {
    const at = Date.parse(image.at);
    if (image.label !== "image" || Number.isNaN(at) || at >= cutoff) return false;
    if (used.has(image.id)) return false;
    return !skipTasks.has(image.task);
  });
}

/** Every local image majhi labelled, with its newest date, size, tags and the task that built it. */
export async function listImages(docker: PruneDocker): Promise<ImageRow[]> {
  const ids = lines(
    await docker.exec(["image", "ls", "-q", "--no-trunc", "--filter", `label=${IMAGE_LABEL}`]),
  );
  if (ids.length === 0) return [];
  const none = (key: string) => `{{with index .Config.Labels "${key}"}}{{.}}{{else}}-{{end}}`;
  const rows = lines(
    await docker.exec([
      "image",
      "inspect",
      "--format",
      `{{.Id}} {{.Created}} {{.Metadata.LastTagTime}} {{.Size}} ${none("majhi.container")} ${none("majhi.task")} {{join .RepoTags ","}}`,
      ...new Set(ids),
    ]),
  );
  return rows.flatMap((row): ImageRow[] => {
    const [id, created, tagged, size, label, task, refs = ""] = row.split(" ");
    if (id === undefined || created === undefined || tagged === undefined) return [];
    return [
      {
        id,
        at: NEVER.test(tagged) || Date.parse(tagged) < Date.parse(created) ? created : tagged,
        bytes: Number(size) || 0,
        refs: refs.split(",").filter(Boolean),
        label: label === undefined || label === "-" ? "" : label,
        task: task === undefined || task === "-" ? "" : task,
      },
    ];
  });
}

/** The ids of the images that containers, running or stopped, are made from. */
export async function usedImages(docker: PruneDocker): Promise<Set<string>> {
  const containers = lines(await docker.exec(["ps", "-a", "-q", "--no-trunc"]));
  if (containers.length === 0) return new Set();
  return new Set(lines(await docker.exec(["inspect", "--format", "{{.Image}}", ...containers])));
}

/** What would go: majhi's old unused preview images. */
export async function findUnusedImages(
  docker: PruneDocker,
  now: Date,
  days = PRUNE_AGE_DAYS,
  skipTasks: ReadonlySet<string> = new Set(),
): Promise<ImageRow[]> {
  return selectUnusedImages(await listImages(docker), await usedImages(docker), now, days, skipTasks);
}

/** Removes images. No --force: docker refuses an image a container uses or a tag shared with another. */
export async function removeImages(
  docker: PruneDocker,
  images: readonly ImageRow[],
): Promise<{ removed: number; bytes: number }> {
  let removed = 0;
  let bytes = 0;
  for (const image of images) {
    try {
      await docker.exec(["image", "rm", bareId(image.id)]);
      removed++;
      bytes += image.bytes;
    } catch (err) {
      console.error(`Image prune: ${errorMessage(err)}`);
    }
  }
  return { removed, bytes };
}

/** The volumes majhi made for tasks (label `majhi.container=volume`). */
export async function listTaskVolumes(docker: PruneDocker): Promise<VolumeRow[]> {
  const rows = lines(
    await docker.exec([
      "volume",
      "ls",
      "--filter",
      "label=majhi.container=volume",
      "--format",
      '{{.Label "majhi.task"}} {{.Name}}',
    ]),
  );
  return rows.flatMap((row): VolumeRow[] => {
    const [task, name] = row.split(" ");
    return task === undefined || name === undefined ? [] : [{ task, name }];
  });
}

/** What a task is to the volume prune: still open, gone, or done since `doneAt`. */
export type TaskAge = "open" | "gone" | { doneAt: string };

/** The volumes of tasks that are gone or were done for at least `days`. Open tasks keep theirs. */
export function selectOldVolumes(
  volumes: readonly VolumeRow[],
  age: (task: string) => TaskAge,
  now: Date,
  days: number = PRUNE_AGE_DAYS,
): VolumeRow[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return volumes.filter((v) => {
    const a = age(v.task);
    if (a === "open") return false;
    if (a === "gone") return true;
    const at = Date.parse(a.doneAt);
    return !Number.isNaN(at) && at < cutoff;
  });
}

export async function removeVolumes(docker: PruneDocker, volumes: readonly VolumeRow[]): Promise<number> {
  if (volumes.length === 0) return 0;
  await docker.exec(["volume", "rm", "-f", ...volumes.map((v) => v.name)]);
  return volumes.length;
}

/** Drops a task builder's build cache that nothing used for `days`. The builder's own state stays. */
export async function pruneBuilderCache(
  docker: PruneDocker,
  builder: string,
  days = PRUNE_AGE_DAYS,
): Promise<void> {
  await docker.exec(["buildx", "prune", "--builder", builder, "--force", "--filter", `until=${days * 24}h`]);
}

/** `21.6GB`, `340MB`, `0B`: docker's own units, decimal. */
export function parseDockerSize(text: string): number | undefined {
  const m = /^([\d.]+)\s*([kKMGT]?B)/.exec(text.trim());
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  const unit = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()];
  return unit === undefined ? undefined : Math.round(Number(m[1]) * unit);
}

/** What Docker holds on disk, from `docker system df`. */
export interface DockerUsage {
  imagesBytes: number;
  volumesBytes: number;
  cacheBytes: number;
  containersBytes: number;
}

export async function dockerUsage(docker: PruneDocker): Promise<DockerUsage> {
  const out = lines(await docker.exec(["system", "df", "--format", "{{.Type}}|{{.Size}}"]));
  const sizes = new Map(out.map((row) => row.split("|") as [string, string]));
  const of = (type: string) => parseDockerSize(sizes.get(type) ?? "") ?? 0;
  return {
    imagesBytes: of("Images"),
    containersBytes: of("Containers"),
    volumesBytes: of("Local Volumes"),
    cacheBytes: of("Build Cache"),
  };
}

const StampSchema = z.object({ at: z.iso.datetime() });

/** When the last weekly prune ran, from `<majhiHome>/cache/containers-prune.json`. */
export async function lastPrune(majhiHome: string): Promise<Date | undefined> {
  try {
    const parsed = StampSchema.safeParse(JSON.parse(await readFile(stampPath(majhiHome), "utf8")));
    return parsed.success ? new Date(parsed.data.at) : undefined;
  } catch {
    return undefined;
  }
}

export async function savePrune(majhiHome: string, at: Date): Promise<void> {
  await mkdir(dirname(stampPath(majhiHome)), { recursive: true });
  await writeFileAtomic(stampPath(majhiHome), `${JSON.stringify({ at: at.toISOString() })}\n`);
}

const stampPath = (majhiHome: string) => join(majhiHome, "cache", "containers-prune.json");
