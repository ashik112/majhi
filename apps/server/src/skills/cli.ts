import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEnv, Command, Spawner } from "@majhi/acp";
import { z } from "zod";
import { errorCode, errorMessage, UserError } from "../errors.ts";

/** The version of the Vercel `skills` CLI the runner image has. Raise it here and in the Dockerfile together. */
export const SKILLS_CLI_VERSION = "1.7.0";

const TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 64 * 1024;
/** A stage folder older than this belongs to a preview nobody confirmed, or to an install a restart cut short. */
const STAGE_MAX_AGE_MS = 2 * 60 * 60_000;
const STAGE_PREFIX = "stage-";

export interface SkillsCliDeps {
  /** Starts programs where an agent's would run: the runner container, or a child of majhi. */
  spawner: Spawner;
  /** PATH and LANG of runs. Never majhi's own environment. */
  base: BaseEnv;
  /** Where stage folders go: in the tasks folder, which a runner can mount. */
  scratchRoot: () => Promise<string>;
  /** The binary. Default `skills`, pinned in the runner image. Tests give a fake one. */
  command?: Command;
  /**
   * Extra environment for fetching `source` as `org`: the org's git login for a private repo, as git
   * settings in the environment. Values are never logged.
   */
  gitEnv?: (org: string | undefined, source: string) => Promise<Record<string, string>>;
  timeoutMs?: number;
}

/** A throwaway working folder for one fetch: its own HOME, a `src` for local sources, and the CLI's output. */
export class Stage {
  constructor(readonly dir: string) {}

  get home(): string {
    return join(this.dir, "home");
  }

  /** Where a folder or a zip's files are put before the CLI reads them. */
  get src(): string {
    return join(this.dir, "src");
  }

  dispose(): Promise<void> {
    return rm(this.dir, { recursive: true, force: true });
  }
}

/** What the CLI left in the stage: each skill's folder, and what its lock says of where it came from. */
export interface Fetched {
  skills: { dir: string; folder: string }[];
  lock: Record<string, { source?: string; sourceType?: string; ref?: string; commit?: string }>;
}

const CliLockSchema = z.object({
  skills: z
    .record(
      z.string(),
      z.object({
        source: z.string().optional(),
        sourceType: z.string().optional(),
        ref: z.string().optional(),
        commit: z.string().optional(),
        sha: z.string().optional(),
      }),
    )
    .default({}),
});

/**
 * The Vercel `skills` CLI, run non-interactively in a runner (SPEC 5.2): `skills add <source> -y
 * --copy --agent claude-code codex`, with telemetry off, a throwaway HOME and working folder. It
 * only fetches: the result is read from the stage and moved into majhi's own store by the caller.
 */
export class SkillsCli {
  constructor(private readonly deps: SkillsCliDeps) {}

  async createStage(): Promise<Stage> {
    const root = await this.deps.scratchRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await sweep(root);
    const stage = new Stage(join(root, `${STAGE_PREFIX}${randomBytes(8).toString("hex")}`));
    await mkdir(stage.dir, { mode: 0o700 });
    await mkdir(stage.home, { mode: 0o700 });
    return stage;
  }

  /** Runs `skills add` in the stage and reads what it installed there. */
  async add(
    stage: Stage,
    input: { source: string; skill?: string | undefined; org?: string | undefined },
  ): Promise<Fetched> {
    const { base } = this.deps;
    const git = (await this.deps.gitEnv?.(input.org, input.source)) ?? {};
    const env: Record<string, string> = {
      PATH: base.PATH,
      HOME: stage.home,
      DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      CI: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...(base.LANG ? { LANG: base.LANG } : {}),
      ...git,
    };
    const bin = this.deps.command ?? { command: "skills", args: [] };
    const args = [
      ...bin.args,
      "add",
      input.source,
      "-y",
      "--copy",
      "--agent",
      "claude-code",
      "codex",
      ...(input.skill === undefined ? [] : ["--skill", input.skill]),
    ];
    const secrets = Object.entries(git)
      .filter(([key]) => key.startsWith("GIT_CONFIG_VALUE_"))
      .map(([, value]) => value);
    const result = await this.run({ command: bin.command, args }, env, stage.dir);
    if (result.missing) {
      throw new UserError(
        `The skills CLI is not installed where agents run (skills@${SKILLS_CLI_VERSION} is in the runner image). Rebuild the runner image.`,
        501,
      );
    }
    if (result.code !== 0) {
      throw new UserError(`skills add failed: ${tail(result.stderr || result.stdout, secrets)}`);
    }
    return this.read(stage);
  }

  private async read(stage: Stage): Promise<Fetched> {
    const skills: Fetched["skills"] = [];
    // `.agents/skills` is where the CLI keeps the copy both agents share; `.claude/skills` is its twin.
    for (const rel of [".agents/skills", ".claude/skills"]) {
      const root = join(stage.dir, rel);
      const names = await readdir(root).catch(() => [] as string[]);
      for (const folder of names.sort()) {
        const dir = join(root, folder);
        const has = await stat(join(dir, "SKILL.md")).then(
          (s) => s.isFile(),
          () => false,
        );
        if (has && !skills.some((s) => s.folder === folder)) skills.push({ dir, folder });
      }
    }
    if (skills.length === 0) {
      throw new UserError("The skills CLI found no skill there: a skill is a folder with a SKILL.md.");
    }
    let lock: Fetched["lock"] = {};
    try {
      const parsed = CliLockSchema.parse(
        JSON.parse(await readFile(join(stage.dir, "skills-lock.json"), "utf8")),
      );
      lock = Object.fromEntries(
        Object.entries(parsed.skills).map(([name, e]) => [
          name,
          {
            ...(e.source === undefined ? {} : { source: e.source }),
            ...(e.sourceType === undefined ? {} : { sourceType: e.sourceType }),
            ...(e.ref === undefined ? {} : { ref: e.ref }),
            ...((e.commit ?? e.sha) === undefined ? {} : { commit: (e.commit ?? e.sha) as string }),
          },
        ]),
      );
    } catch {
      // No lock, or one in a shape this version does not know: the caller records the source it was given.
    }
    return { skills, lock };
  }

  private run(
    command: Command,
    env: Record<string, string>,
    cwd: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let done = false;
      let kill = () => {};
      const finish = (r: { code: number | null; missing: boolean }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ...r, stdout, stderr });
      };
      const limit = this.deps.timeoutMs ?? TIMEOUT_MS;
      const timer = setTimeout(() => {
        kill();
        stderr += `\nStopped after ${limit / 1000} s.`;
        finish({ code: null, missing: false });
      }, limit);
      this.deps.spawner({ command, env, cwd }).then(
        (spawned) => {
          kill = spawned.kill;
          const { child } = spawned;
          child.stdout.on("data", (c: Buffer) => {
            if (stdout.length < MAX_OUTPUT) stdout += c.toString();
          });
          child.stderr.on("data", (c: Buffer) => {
            if (stderr.length < MAX_OUTPUT) stderr += c.toString();
          });
          child.stdin.end();
          child.once("error", (err) => {
            stderr += errorMessage(err);
            finish({ code: null, missing: errorCode(err) === "ENOENT" });
          });
          child.once("close", (code) => finish({ code, missing: code === 127 }));
        },
        (err) => {
          stderr += errorMessage(err);
          finish({ code: null, missing: errorCode(err) === "ENOENT" });
        },
      );
    });
  }
}

/** The last few lines of output, without colors, a secret value or a path to a throwaway home. */
function tail(text: string, secrets: readonly string[]): string {
  let out = text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[secret]");
  const lines = out
    .split("\n")
    .map((l) => l.replace(/^[│◇●└┌├╮╯─\s]+/u, "").trim())
    .filter((l) => l !== "");
  const last = lines.slice(-4).join(" ");
  return last.length > 400 ? `${last.slice(0, 399)}…` : last || "no output";
}

/** Removes stage folders nobody came back for. */
async function sweep(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  const cutoff = Date.now() - STAGE_MAX_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(STAGE_PREFIX)) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
  }
}
