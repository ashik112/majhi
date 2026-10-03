import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../errors.ts";
import { writeFileAtomic } from "../fs.ts";
import type { DockerResult } from "./docker.ts";

/**
 * The weekly prune of what majhi built for agents and no longer uses: preview images (labelled
 * `majhi.container=image`) that no container uses, and the build cache of the task builders,
 * each older than `PRUNE_AGE_DAYS`. Only what majhi labelled or named itself; never volumes, and
 * never anything of another project. `DockerCli.exec` refuses any other removal on its own.
 */

export const PRUNE_AGE_DAYS = 7;
/** How often the prune runs. majhi looks once a day and at start, and runs it when this long passed. */
export const PRUNE_EVERY_MS = 7 * 86_400_000;

/** The label every image majhi builds carries (`buildArgs`). */
const IMAGE_LABEL = "majhi.container=image";

/** The docker calls the prune makes: reads and removals of majhi's own things only. */
export type PruneDocker = { exec(args: readonly string[]): Promise<DockerResult> };

/** An image as `image inspect` shows it. */
export interface InspectedImage {
  id: string;
  created: string;
  /** The value of `majhi.container`, empty when the image has no such label. */
  label: string;
}

/**
 * The images to remove: labelled `majhi.container=image`, made before `now - days`, and used by
 * no container. Pure, so the choice is tested without docker.
 */
export function selectOldImages(
  images: readonly InspectedImage[],
  used: ReadonlySet<string>,
  now: Date,
  days: number = PRUNE_AGE_DAYS,
): string[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return images.flatMap((image) => {
    const created = Date.parse(image.created);
    if (image.label !== "image" || Number.isNaN(created) || created >= cutoff) return [];
    if (used.has(image.id)) return [];
    return [image.id];
  });
}

const lines = (out: DockerResult): string[] =>
  out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** `sha256:<hex>` as the bare hex, the form `DockerCli.exec` accepts for a removal. */
const bareId = (id: string): string => id.replace(/^sha256:/, "");

/** Removes majhi's old unused images. Returns how many went. */
export async function pruneImages(docker: PruneDocker, now: Date, days = PRUNE_AGE_DAYS): Promise<number> {
  const ids = lines(
    await docker.exec(["image", "ls", "-q", "--no-trunc", "--filter", `label=${IMAGE_LABEL}`]),
  );
  if (ids.length === 0) return 0;
  const images = lines(
    await docker.exec([
      "image",
      "inspect",
      "--format",
      '{{.Id}} {{.Created}} {{index .Config.Labels "majhi.container"}}',
      ...new Set(ids),
    ]),
  ).flatMap((row): InspectedImage[] => {
    const [id, created, label] = row.split(" ");
    return id === undefined || created === undefined ? [] : [{ id, created, label: label ?? "" }];
  });
  const containers = lines(await docker.exec(["ps", "-a", "-q", "--no-trunc"]));
  const used = new Set(
    containers.length === 0
      ? []
      : lines(await docker.exec(["inspect", "--format", "{{.Image}}", ...containers])),
  );
  let removed = 0;
  for (const id of selectOldImages(images, used, now, days)) {
    try {
      // No --force: docker itself refuses an image a container uses.
      await docker.exec(["image", "rm", bareId(id)]);
      removed++;
    } catch (err) {
      console.error(`Image prune: ${errorMessage(err)}`);
    }
  }
  return removed;
}

/** Drops a task builder's build cache that nothing used for `days`. The builder's own state stays. */
export async function pruneBuilderCache(
  docker: PruneDocker,
  builder: string,
  days = PRUNE_AGE_DAYS,
): Promise<void> {
  await docker.exec(["buildx", "prune", "--builder", builder, "--force", "--filter", `until=${days * 24}h`]);
}

const StampSchema = z.object({ at: z.iso.datetime() });

/** When the last prune ran, from `<majhiHome>/cache/containers-prune.json`. */
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
