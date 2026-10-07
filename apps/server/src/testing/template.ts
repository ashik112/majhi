import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";

/**
 * Worlds made once and copied. A test world starts with the same setup every time (an org, an account,
 * an agent, a repo, a project), which is dozens of git processes and commands. The first test of a
 * run that needs a world builds it into a template folder; every later test copies that folder,
 * which takes milliseconds. The folder lives under a root made by the run's global setup and removed
 * when the run ends, so it never outlives the code that made it. Without that root (a tool that does
 * not run the global setup), a folder of the process's own is used.
 */

declare module "vitest" {
  interface ProvidedContext {
    majhiTemplateRoot: string;
  }
}

const own: { root?: Promise<string> } = {};
/** Set by the global setup, which has no injected root of its own: it is the one that makes it. */
let forcedRoot: string | undefined;

export function useTemplateRoot(root: string | undefined): void {
  forcedRoot = root;
}

async function templateRoot(): Promise<string> {
  if (forcedRoot !== undefined) return forcedRoot;
  const provided = inject("majhiTemplateRoot");
  if (typeof provided === "string" && provided !== "") return provided;
  own.root ??= mkdtemp(join(tmpdir(), "majhi-templates-"));
  return own.root;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** What a builder hands back: the finished home, still on disk, and where it was built. */
export interface BuiltTemplate {
  dir: string;
  /** Files that name `dir` and are rewritten for each copy. Every other file must not name it. */
  patch: readonly string[];
}

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

/** Fails when a file other than the listed ones names the folder the template was built in. */
async function assertRelocatable(built: BuiltTemplate): Promise<void> {
  const needle = Buffer.from(built.dir);
  const allowed = new Set(built.patch.map((p) => join(built.dir, p)));
  for await (const path of files(built.dir)) {
    if (allowed.has(path)) continue;
    if ((await readFile(path)).includes(needle)) {
      throw new Error(`The test world template names its own folder in ${path}; list it in "patch".`);
    }
  }
}

/**
 * The folder of the template named `key`, built by `build` the first time any test process asks.
 * `build` makes a world, closes it, and returns where it is; the world's folder is copied in and
 * removed.
 */
async function templateFor(key: string, build: () => Promise<BuiltTemplate>): Promise<string> {
  return buildTemplate(await templateRoot(), key, build);
}

/**
 * Makes the template named `key` under `root` if no process has, and waits for the one that is making
 * it. The run's global setup calls this for the templates most tests need, so no test pays for them.
 */
export async function buildTemplate(
  root: string,
  key: string,
  build: () => Promise<BuiltTemplate>,
): Promise<string> {
  const name = createHash("sha1").update(key).digest("hex").slice(0, 16);
  const final = join(root, name);
  const lock = join(root, `${name}.lock`);
  for (let attempt = 0; attempt < 3000; attempt++) {
    if (await exists(`${final}.done`)) return final;
    const mine = await mkdir(lock).then(
      () => true,
      () => false,
    );
    if (mine) {
      try {
        if (await exists(`${final}.done`)) return final;
        const built = await build();
        await assertRelocatable(built);
        await cp(built.dir, final, { recursive: true });
        await writeFile(`${final}.origin`, JSON.stringify({ dir: built.dir, patch: built.patch }));
        await rm(built.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        await writeFile(`${final}.done`, "");
        return final;
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for the test world template ${key}`);
}

/**
 * Fills `target`, an empty folder, with a copy of the template named `key`, with the folder name
 * rewritten in the files that hold it.
 */
export async function copyTemplate(
  key: string,
  target: string,
  build: () => Promise<BuiltTemplate>,
): Promise<void> {
  const from = await templateFor(key, build);
  const origin = JSON.parse(await readFile(`${from}.origin`, "utf8")) as { dir: string; patch: string[] };
  await cp(from, target, { recursive: true });
  for (const file of origin.patch) {
    const path = join(target, file);
    await writeFile(path, (await readFile(path, "utf8")).split(origin.dir).join(target));
  }
}
