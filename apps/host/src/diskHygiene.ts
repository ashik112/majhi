import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OPEN_TASKS_FILE, OpenTasksSchema } from "@majhi/shared";

/**
 * What an update removes of majhi's own old images once the new majhi runs. Only things majhi
 * built or named: the `majhi-server:previous` / `majhi-laya:previous` tags, `majhi-preview-<task>`
 * images (label `majhi.container=image`) of tasks that are done or gone, their buildx builders and
 * builder state volumes, and dangling images that carry a majhi label. Never another project's
 * images, volumes or containers, and never the build cache.
 */

/** Images carry these labels: previews (`majhi.container=image`) and the images compose builds. */
export const MAJHI_IMAGE_LABELS = ["majhi.container=image", "majhi.owned=build"] as const;
/** The tags `update` keeps before building, so a failed update can go back. Not needed once it succeeded. */
export const PREVIOUS_TAGS = ["majhi-server:previous", "majhi-laya:previous"] as const;

const KEY = "([a-z][a-z0-9]{0,9}-[1-9][0-9]*)";
const PREVIEW_NAME = new RegExp(`^majhi-preview-${KEY}$`);
const STATE_VOLUME = new RegExp(`^buildx_buildkit_majhi-preview-${KEY}0_state$`);
const STEP_TIMEOUT_MS = 60_000;
const IMAGE_FORMAT = "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}";

type Step = (label: string, args: string[], timeout: number) => Promise<string>;

/** The ids (lowercased) of the tasks that are not done, or undefined when they are not known. */
export async function readOpenTasks(majhiHome: string): Promise<Set<string> | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(majhiHome, OPEN_TASKS_FILE), "utf8"));
    return new Set(OpenTasksSchema.parse(raw).tasks.map((id) => id.toLowerCase()));
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

/** The preview images to remove: majhi's name, and the task is not open. Open tasks unknown: none. */
export function selectPreviewImages(
  rows: readonly ImageRow[],
  open: ReadonlySet<string> | undefined,
): ImageRow[] {
  if (open === undefined) return [];
  return rows.filter((r) => {
    const key = PREVIEW_NAME.exec(r.repository)?.[1];
    return key !== undefined && !open.has(key);
  });
}

/** The buildx builders of previews of tasks that are not open. */
export function selectBuilders(names: readonly string[], open: ReadonlySet<string> | undefined): string[] {
  if (open === undefined) return [];
  return names.filter((n) => {
    const key = PREVIEW_NAME.exec(n)?.[1];
    return key !== undefined && !open.has(key);
  });
}

/** The state volumes of those builders. */
export function selectStateVolumes(
  names: readonly string[],
  open: ReadonlySet<string> | undefined,
): string[] {
  if (open === undefined) return [];
  return names.filter((n) => {
    const key = STATE_VOLUME.exec(n)?.[1];
    return key !== undefined && !open.has(key);
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
 * Removes the images and builders listed above and reports them in plain words, with sizes. Every
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
  const removeImage = async (ref: string, size: string): Promise<void> => {
    if (!(await attempt(step("remove an old image", ["image", "rm", ref], STEP_TIMEOUT_MS)))) return;
    total += sizeBytes(size);
    gone.push(size === "" ? ref : `${ref} (${size})`);
  };

  for (const tag of tags) {
    const listed = await step(
      "find the previous image",
      ["image", "ls", "--format", IMAGE_FORMAT, tag],
      STEP_TIMEOUT_MS,
    ).catch(() => "");
    const row = parseImages(listed).find((r) => `${r.repository}:${r.tag}` === tag);
    if (row !== undefined) await removeImage(tag, row.size);
  }

  const open = await readOpenTasks(majhiHome);
  if (open === undefined) {
    await say("Kept the preview images: the list of open tasks was not available");
  } else {
    const listed = await step(
      "list preview images",
      [
        "image",
        "ls",
        "--filter",
        "reference=majhi-preview-*",
        "--filter",
        `label=${MAJHI_IMAGE_LABELS[0]}`,
        "--format",
        IMAGE_FORMAT,
      ],
      STEP_TIMEOUT_MS,
    ).catch(() => "");
    for (const row of selectPreviewImages(parseImages(listed), open)) {
      await removeImage(`${row.repository}:${row.tag}`, row.size);
    }
    const builders = await step("list builders", ["buildx", "ls", "--format", "{{.Name}}"], STEP_TIMEOUT_MS)
      .then((out) => lines(out).map((n) => n.replace(/\*$/, "")))
      .catch(() => []);
    for (const name of selectBuilders(builders, open)) {
      if (
        await attempt(step("remove a preview builder", ["buildx", "rm", "--force", name], STEP_TIMEOUT_MS))
      ) {
        gone.push(`builder ${name}`);
      }
    }
    const volumes = await step("list volumes", ["volume", "ls", "--format", "{{.Name}}"], STEP_TIMEOUT_MS)
      .then(lines)
      .catch(() => []);
    for (const name of selectStateVolumes(volumes, open)) {
      if (await attempt(step("remove a builder state volume", ["volume", "rm", name], STEP_TIMEOUT_MS))) {
        gone.push(`volume ${name}`);
      }
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
