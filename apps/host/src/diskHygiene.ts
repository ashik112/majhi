import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OPEN_TASKS_FILE, OpenTasksSchema } from "@majhi/shared";

/**
 * What an update removes of majhi's own old images once the new majhi runs. Only things majhi labelled:
 * the `majhi-server:previous` / `majhi-laya:previous` tags, images carrying `majhi.container=image` (a
 * preview, or an image a script built) whose task (`majhi.task`) is done or gone, and dangling images that
 * carry a majhi label. The builders and volumes of the old per-task model are removed by the server itself
 * when it starts, by task id. Never another project's images, volumes or containers, and never the build
 * cache beyond its age cap.
 */

/** Images carry these labels: previews and script builds (`majhi.container=image`) and the images compose builds. */
export const MAJHI_IMAGE_LABELS = ["majhi.container=image", "majhi.owned=build"] as const;
/** The label that says which task built an image. */
const BUILT_BY_LABEL = "majhi.task";
/** The tags `update` keeps before building, so a failed update can go back. Not needed once it succeeded. */
export const PREVIOUS_TAGS = ["majhi-server:previous", "majhi-laya:previous"] as const;

const STEP_TIMEOUT_MS = 60_000;
const IMAGE_FORMAT = "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}";

type Step = (label: string, args: string[], timeout: number) => Promise<string>;

/** The ids of the tasks that are not done, or undefined when they are not known. */
export async function readOpenTasks(majhiHome: string): Promise<Set<string> | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(majhiHome, OPEN_TASKS_FILE), "utf8"));
    return new Set(OpenTasksSchema.parse(raw).tasks);
  } catch {
    return undefined;
  }
}

/** One image row of `docker image ls`. */
export interface ImageRow {
  repository: string;
  tag: string;
  id: string;
  size: string;
}

const lines = (out: string): string[] =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

function parseImages(out: string): ImageRow[] {
  return lines(out).flatMap((row) => {
    const [repository, tag, id, size] = row.split("\t");
    return repository === undefined || tag === undefined || id === undefined
      ? []
      : [{ repository, tag, id, size: size ?? "" }];
  });
}

/** An image majhi labelled, with the task that built it. */
export interface OwnImage {
  /** What to remove it by: `repository:tag`, or the id when it has no tag. */
  ref: string;
  /** `majhi.task`, empty when the image has no such label. */
  builtBy: string;
  bytes: number;
}

/** The images to remove: majhi's own, built by a task that is not open. Open tasks unknown: none. */
export function selectOwnImages(rows: readonly OwnImage[], open: ReadonlySet<string> | undefined): OwnImage[] {
  if (open === undefined) return [];
  return rows.filter((r) => r.builtBy !== "" && !open.has(r.builtBy));
}

/** The labelled images of majhi's, read from `docker image inspect` rows: `id`, built-by label, bytes, tags. */
function parseOwnImages(out: string): OwnImage[] {
  return lines(out).flatMap((row) => {
    const [id, builtBy = "", bytes = "0", tags = ""] = row.split("\t");
    if (id === undefined) return [];
    const tag = tags.split(",").find((t) => t !== "");
    return [{ ref: tag ?? id, builtBy, bytes: Number(bytes) || 0 }];
  });
}

/** "1.2GB" or "512MB" as bytes. 0 when it cannot be read. */
export function sizeBytes(size: string): number {
  const m = /^([0-9.]+)\s*([kKMGT]?B)$/.exec(size.trim());
  if (m === null) return 0;
  const units: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Number(m[1]) * (units[(m[2] ?? "B").toUpperCase()] ?? 1);
}

export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

const attempt = (run: Promise<unknown>): Promise<boolean> =>
  run.then(
    () => true,
    () => false,
  );

/**
 * Removes the images listed above and reports them in plain words, with sizes. Every
 * removal is best effort: a failed one is skipped and never fails an update that already runs.
 */
/** The most the Docker build cache may hold after an update; older layers above it are trimmed. */
export const BUILD_CACHE_CAP = "15gb";

/**
 * Ages the cache is trimmed by, oldest first. Docker 29's `--max-used-space` and `--keep-storage` free
 * nothing in practice, so the cap is kept by age: drop unused cache older than each step until the
 * cache is under the cap. Never an unfiltered prune.
 */
export const BUILD_CACHE_AGES = ["168h", "72h", "48h", "24h", "12h", "6h", "3h"] as const;

export async function removeOwnLeftovers(
  step: Step,
  majhiHome: string,
  say: (text: string) => Promise<void>,
  tags: readonly string[] = PREVIOUS_TAGS,
): Promise<void> {
  let total = 0;
  const gone: string[] = [];
  const removeImage = async (ref: string, label: string, bytes: number): Promise<void> => {
    if (!(await attempt(step("remove an old image", ["image", "rm", ref], STEP_TIMEOUT_MS)))) return;
    total += bytes;
    gone.push(label);
  };

  for (const tag of tags) {
    const listed = await step(
      "find the previous image",
      ["image", "ls", "--format", IMAGE_FORMAT, tag],
      STEP_TIMEOUT_MS,
    ).catch(() => "");
    const row = parseImages(listed).find((r) => `${r.repository}:${r.tag}` === tag);
    if (row !== undefined) await removeImage(tag, row.size === "" ? tag : `${tag} (${row.size})`, sizeBytes(row.size));
  }

  const open = await readOpenTasks(majhiHome);
  if (open === undefined) {
    await say("Kept the preview images: the list of open tasks was not available");
  } else {
    // By label: the images majhi built, and the task that built each. No name is read as a pattern.
    const ids = await step(
      "list majhi's images",
      ["image", "ls", "-q", "--no-trunc", "--filter", `label=${MAJHI_IMAGE_LABELS[0]}`],
      STEP_TIMEOUT_MS,
    )
      .then(lines)
      .catch(() => []);
    const inspected =
      ids.length === 0
        ? ""
        : await step(
            "read majhi's images",
            [
              "image",
              "inspect",
              "--format",
              `{{.Id}}\t{{index .Config.Labels "${BUILT_BY_LABEL}"}}\t{{.Size}}\t{{join .RepoTags ","}}`,
              ...new Set(ids),
            ],
            STEP_TIMEOUT_MS,
          ).catch(() => "");
    for (const image of selectOwnImages(parseOwnImages(inspected), open)) {
      await removeImage(image.ref, `${image.ref} (${sizeText(image.bytes)})`, image.bytes);
    }
  }

  // Dangling images majhi built: one pass per label, never an unfiltered prune.
  for (const label of MAJHI_IMAGE_LABELS) {
    const listed = await step(
      "list dangling images",
      ["image", "ls", "--filter", "dangling=true", "--filter", `label=${label}`, "--format", IMAGE_FORMAT],
      STEP_TIMEOUT_MS,
    ).catch(() => "");
    const dangling = parseImages(listed);
    if (dangling.length === 0) continue;
    if (
      !(await attempt(
        step(
          "remove dangling images",
          ["image", "prune", "-f", "--filter", `label=${label}`],
          STEP_TIMEOUT_MS,
        ),
      ))
    )
      continue;
    const bytes = dangling.reduce((n, r) => n + sizeBytes(r.size), 0);
    total += bytes;
    gone.push(
      `${dangling.length} dangling ${dangling.length === 1 ? "image" : "images"} (${sizeText(bytes)})`,
    );
  }

  // The build cache is capped, not cleared: the newest layers keep updates fast, and only the oldest
  // unused ones above the cap go, by age, never an unfiltered prune (the owner's rule).
  const cap = sizeBytes(BUILD_CACHE_CAP.toUpperCase());
  const cacheSize = async (): Promise<number | undefined> => {
    const out = await step(
      "measure the build cache",
      ["system", "df", "--format", "{{.Type}}\t{{.Size}}"],
      STEP_TIMEOUT_MS,
    ).catch(() => "");
    const row = lines(out)
      .map((l) => l.split("\t"))
      .find(([type]) => type === "Build Cache");
    return row?.[1] === undefined ? undefined : sizeBytes(row[1]);
  };
  const before = await cacheSize();
  if (before !== undefined && before > cap) {
    let now = before;
    for (const age of BUILD_CACHE_AGES) {
      if (now <= cap) break;
      await attempt(
        step(
          "cap the build cache",
          ["builder", "prune", "-f", "-a", "--filter", `until=${age}`],
          STEP_TIMEOUT_MS,
        ),
      );
      now = (await cacheSize()) ?? now;
    }
    if (now < before) {
      total += before - now;
      gone.push(`build cache trimmed from ${sizeText(before)} to ${sizeText(now)}`);
    }
  }

  await say(
    gone.length === 0
      ? "No old majhi images to remove"
      : `Removed ${gone.join(", ")}. About ${sizeText(total)} freed`,
  );
}

/** The label the release workflow puts on every release image, with its version. */
export const RELEASE_LABEL = "majhi.release";

/**
 * The release images (`<registry>/majhi-*:<tag>`, from ghcr.io) of other versions than `version`:
 * what runs now was built on that version's. The `majhi-*:dev` images built on them carry the label
 * too, but have no registry in their name, so they are never picked.
 */
export function selectOtherReleases(rows: readonly ImageRow[], version: string): ImageRow[] {
  return rows.filter(
    (r) =>
      r.repository.includes("/") &&
      r.tag !== "<none>" &&
      r.tag !== version &&
      !r.tag.startsWith(`${version}-`),
  );
}

/** After a release install moved to `version`: removes the release images of the version before. Best effort. */
export async function removeOtherReleases(
  step: Step,
  version: string,
  say: (text: string) => Promise<void>,
): Promise<void> {
  const listed = await step(
    "list release images",
    ["image", "ls", "--filter", `label=${RELEASE_LABEL}`, "--format", IMAGE_FORMAT],
    STEP_TIMEOUT_MS,
  ).catch(() => "");
  const gone: string[] = [];
  for (const row of selectOtherReleases(parseImages(listed), version)) {
    const ref = `${row.repository}:${row.tag}`;
    if (await attempt(step("remove an old release image", ["image", "rm", ref], STEP_TIMEOUT_MS)))
      gone.push(ref);
  }
  if (gone.length > 0) await say(`Removed the images of the release before: ${gone.join(", ")}`);
}
