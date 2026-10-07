import { detectSecrets } from "@majhi/shared";
import { type CheckKind, classifyCommand, wordsOf } from "./classify.ts";
import type { CiFiles } from "./read.ts";
import { parseShell, renderShell } from "./shell.ts";

/**
 * The checks a repo's own CI runs. Each CI job is read into the commands it runs with the environment
 * and folder they run in; the first job that runs a lint, a type check, the tests or the build gives
 * that check its command. Majhi's hand-off runs the same line in the same environment, so it passes and
 * fails where the CI does.
 */

export type CiSystem = "github-actions" | "gitlab-ci" | "bitbucket";

/** One check taken from a CI job. */
export interface CiCheck {
  kind: CheckKind;
  /** The shell line, as the job runs it. */
  command: string;
  /** Literal environment variables of the workflow, the job and the step. Nothing that looks like a secret. */
  env: Record<string, string>;
  /** The folder it runs in, relative to the repo root. Absent: the root. */
  workdir?: string | undefined;
  /** Where it came from: "from .gitlab-ci.yml job build". */
  from: string;
  /** The minutes the CI gives the job, when it says. */
  minutes?: number | undefined;
  /** Services the job starts next to it (a database, a cache), as the job declares them. */
  services: CiService[];
}

/** A container the CI job starts next to its steps. */
export interface CiService {
  /** The name the job gives it (`postgres`), which is also the host name its steps reach it by in CI. */
  name: string;
  image: string;
  /** Literal environment of the container. */
  env: Record<string, string>;
  /** `5432:5432` or `5432`, as the job writes them. */
  ports: string[];
  /** Health options the job gives it: `--health-cmd` and its timing. Nothing else of `options` is followed. */
  health?: { cmd: string; interval?: string; timeout?: string; retries?: number } | undefined;
}

interface Line {
  text: string;
  env: Record<string, string>;
  workdir: string | undefined;
}

interface CiJob {
  system: CiSystem;
  file: string;
  name: string;
  lines: Line[];
  minutes: number | undefined;
  services: CiService[];
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** String values only; a number or a boolean is written as the CI would put it in the environment. */
function envOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(value))) {
    const text =
      typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : typeof record(v).value === "string"
          ? (record(v).value as string)
          : undefined;
    if (text !== undefined) out[k] = text;
  }
  return out;
}

const SECRET_WORDS: ReadonlySet<string> = new Set([
  "secret",
  "token",
  "password",
  "passwd",
  "key",
  "credentials",
  "credential",
  "auth",
  "private",
]);

/** What of an environment is safe to pass on: values known now, and no secret. A job's variables are public to everyone who can read the repo, but they may hold a token the CI fills in. */
export function safeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value.includes("${{") || value.includes("$") || value.includes("`")) continue;
    if (wordsOf(name).some((w) => SECRET_WORDS.has(w))) continue;
    if (detectSecrets(value).length > 0) continue;
    if (value.length > 400) continue;
    out[name] = value;
  }
  return out;
}

/** A service's own environment: literal values, which are not secrets of the CI (they go to a throwaway container, never to an agent). */
function serviceEnv(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(envOf(value))) {
    if (text.includes("${{") || text.includes("$") || text.includes("`")) continue;
    if (detectSecrets(text).length > 0 || text.length > 400) continue;
    out[name] = text;
  }
  return out;
}

/** The name a GitLab service answers to without an alias: its image without the registry, tag and path. */
function defaultServiceName(image: string): string {
  const last = image.split("/").pop() ?? image;
  return last.split(":")[0] ?? last;
}

/** A number of up to four digits, with `ms`, `s` or `m` after it or nothing. */
function isDuration(text: string): boolean {
  const digits = text.length - (text.endsWith("ms") ? 2 : "sm".includes(text.slice(-1)) ? 1 : 0);
  const n = text.slice(0, digits);
  return n.length >= 1 && n.length <= 4 && [...n].every((c) => c >= "0" && c <= "9");
}

/** `--health-cmd "pg_isready" --health-interval 10s ...` of a GitHub service's `options`. Other flags are not followed. */
function healthOf(options: unknown): CiService["health"] {
  if (typeof options !== "string") return undefined;
  const parsed = parseShell(`x ${options}`);
  if (!parsed.ok) return undefined;
  const argv = parsed.segments[0]?.argv.slice(1) ?? [];
  const value = (flag: string): string | undefined => {
    const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i < 0) return undefined;
    return argv[i]?.startsWith(`${flag}=`) ? argv[i]?.slice(flag.length + 1) : argv[i + 1];
  };
  const cmd = value("--health-cmd");
  if (cmd === undefined || cmd.trim() === "") return undefined;
  const retries = Number(value("--health-retries"));
  const interval = value("--health-interval");
  const timeout = value("--health-timeout");
  return {
    cmd,
    ...(interval !== undefined && isDuration(interval) ? { interval } : {}),
    ...(timeout !== undefined && isDuration(timeout) ? { timeout } : {}),
    ...(Number.isInteger(retries) && retries > 0 && retries <= 60 ? { retries } : {}),
  };
}

const linesOf = (value: unknown): string[] => {
  if (typeof value === "string") return value.split("\n");
  if (Array.isArray(value)) return value.flatMap(linesOf);
  return [];
};

function githubMinutes(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function githubJobs(files: CiFiles): CiJob[] {
  const out: CiJob[] = [];
  for (const file of files.workflows) {
    const wf = record(file.located.data);
    const wfEnv = envOf(wf.env);
    const wfDir = record(record(wf.defaults).run)["working-directory"];
    for (const [id, raw] of Object.entries(record(wf.jobs))) {
      const job = record(raw);
      if (typeof job.uses === "string") continue;
      const jobEnv = { ...wfEnv, ...envOf(job.env) };
      const jobDir = record(record(job.defaults).run)["working-directory"] ?? wfDir;
      const lines: Line[] = [];
      for (const step of Array.isArray(job.steps) ? job.steps : []) {
        const s = record(step);
        const dir = typeof s["working-directory"] === "string" ? s["working-directory"] : jobDir;
        if (typeof s.run !== "string") continue;
        const env = { ...jobEnv, ...envOf(s.env) };
        for (const text of linesOf(s.run))
          lines.push({ text, env, workdir: typeof dir === "string" ? dir : undefined });
      }
      const services = Object.entries(record(job.services)).flatMap(([name, v]) => {
        const svc = record(v);
        if (typeof svc.image !== "string") return [];
        return [
          {
            name,
            image: svc.image,
            env: serviceEnv(svc.env),
            ports: (Array.isArray(svc.ports) ? svc.ports : []).flatMap((p) =>
              typeof p === "string" || typeof p === "number" ? [String(p)] : [],
            ),
            health: healthOf(svc.options),
          },
        ];
      });
      out.push({
        system: "github-actions",
        file: file.path,
        name: id,
        lines,
        minutes: githubMinutes(job["timeout-minutes"]),
        services,
      });
    }
  }
  return out;
}

/** GitLab keys that are settings of the file, not jobs. */
const GITLAB_SETTINGS: ReadonlySet<string> = new Set([
  "stages",
  "variables",
  "default",
  "include",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
  "spec",
]);

function gitlabJobs(files: CiFiles): CiJob[] {
  const merged: Record<string, Record<string, unknown>> = {};
  const globals: Record<string, string> = {};
  for (const file of files.gitlab) {
    const root = record(file.located.data);
    Object.assign(globals, envOf(root.variables));
    for (const [id, raw] of Object.entries(root)) {
      if (GITLAB_SETTINGS.has(id)) continue;
      merged[id] = record(raw);
    }
  }
  // `extends` copies a job's keys from another, which may itself extend: followed a few levels, each key as the child sets it.
  const resolve = (id: string, depth: number): Record<string, unknown> => {
    const job = merged[id] ?? {};
    const parents =
      typeof job.extends === "string" ? [job.extends] : Array.isArray(job.extends) ? job.extends : [];
    if (depth > 4 || parents.length === 0) return job;
    let base: Record<string, unknown> = {};
    for (const p of parents) if (typeof p === "string") base = { ...base, ...resolve(p, depth + 1) };
    return { ...base, ...job, variables: { ...record(base.variables), ...record(job.variables) } };
  };
  const out: CiJob[] = [];
  const first = files.gitlab[0]?.path ?? ".gitlab-ci.yml";
  for (const id of Object.keys(merged)) {
    if (id.startsWith(".")) continue;
    const job = resolve(id, 0);
    if (!("script" in job)) continue;
    const env = { ...globals, ...envOf(job.variables) };
    const lines = linesOf(job.script).map((text) => ({ text, env, workdir: undefined }));
    const services = (Array.isArray(job.services) ? job.services : []).flatMap((v): CiService[] => {
      const svc = typeof v === "string" ? { name: v } : record(v);
      const image = svc.name;
      if (typeof image !== "string") return [];
      const name = typeof svc.alias === "string" ? svc.alias : defaultServiceName(image);
      return [{ name, image, env: serviceEnv(svc.variables), ports: [], health: undefined }];
    });
    out.push({ system: "gitlab-ci", file: first, name: id, lines, minutes: undefined, services });
  }
  return out;
}

function bitbucketSteps(entries: unknown, out: Record<string, unknown>[]): void {
  for (const entry of Array.isArray(entries) ? entries : []) {
    const e = record(entry);
    if ("step" in e) out.push(record(e.step));
    const inner = Array.isArray(e.parallel) ? e.parallel : record(e.parallel).steps;
    if (inner !== undefined) bitbucketSteps(inner, out);
    if ("stage" in e) bitbucketSteps(record(e.stage).steps, out);
  }
}

function bitbucketJobs(files: CiFiles): CiJob[] {
  const file = files.bitbucket;
  if (file === undefined) return [];
  const pipelines = record(record(file.located.data).pipelines);
  const steps: Record<string, unknown>[] = [];
  bitbucketSteps(pipelines.default, steps);
  for (const kind of ["branches", "pull-requests"]) {
    for (const entries of Object.values(record(pipelines[kind]))) bitbucketSteps(entries, steps);
  }
  const out: CiJob[] = [];
  steps.forEach((step, i) => {
    const name = typeof step.name === "string" ? step.name : `step ${i + 1}`;
    const lines = linesOf(step.script).map((text) => ({ text, env: {}, workdir: undefined }));
    out.push({
      system: "bitbucket",
      file: file.path,
      name,
      lines,
      minutes: typeof step["max-time"] === "number" ? step["max-time"] : undefined,
      services: [],
    });
  });
  return out;
}

/** Jobs that ship or run something other than the code's own checks. */
const SHIPPING: ReadonlySet<string> = new Set([
  "deploy",
  "release",
  "publish",
  "docker",
  "image",
  "e2e",
  "nightly",
]);

/**
 * The commands of a job in the order they run. `cd dir && cmd` sets the folder for what follows it. A
 * line majhi cannot read with certainty, or one that uses a value only the CI knows (`${{ }}`), is left
 * out: it is not guessed at.
 */
function commandsOf(
  job: CiJob,
): { kind: CheckKind; command: string; env: Record<string, string>; workdir?: string }[] {
  const out: { kind: CheckKind; command: string; env: Record<string, string>; workdir?: string }[] = [];
  let dir: string | undefined;
  for (const line of job.lines) {
    if (line.text.includes("${{")) continue;
    const parsed = parseShell(line.text);
    if (!parsed.ok) continue;
    for (const seg of parsed.segments) {
      if (seg.argv[0] === "cd" && seg.argv[1] !== undefined) {
        dir = seg.argv[1];
        continue;
      }
      const kind = classifyCommand(seg.argv);
      if (kind === undefined || kind === "install") continue;
      // The command alone, with its own variables in front of it: whatever is chained to it runs elsewhere.
      const command = renderShell([{ env: seg.env, argv: seg.argv }]);
      const workdir = line.workdir ?? dir;
      out.push({
        kind,
        command,
        env: { ...line.env, ...seg.env },
        ...(workdir === undefined ? {} : { workdir }),
      });
    }
  }
  return out;
}

/** Every check the repo's CI runs, the first of each kind. */
export function ciChecks(files: CiFiles): CiCheck[] {
  const jobs = [...githubJobs(files), ...gitlabJobs(files), ...bitbucketJobs(files)];
  const found = new Map<CheckKind, CiCheck>();
  for (const job of jobs) {
    if (wordsOf(job.name).some((w) => SHIPPING.has(w))) continue;
    for (const c of commandsOf(job)) {
      if (found.has(c.kind)) continue;
      const clean = safeEnv(c.env);
      // A folder that leaves the repo or holds a value only the CI knows is not followed.
      const dirOk =
        c.workdir === undefined ||
        (!c.workdir.startsWith("/") && !c.workdir.split("/").includes("..") && !c.workdir.includes("$"));
      if (!dirOk) continue;
      const trimmed = c.workdir?.endsWith("/") === true ? c.workdir.slice(0, -1) : c.workdir;
      const workdir = trimmed === "." || trimmed === "" ? undefined : trimmed;
      found.set(c.kind, {
        kind: c.kind,
        command: c.command,
        env: clean,
        ...(workdir === undefined ? {} : { workdir }),
        from: `from ${job.file} job ${job.name}`,
        minutes: job.minutes,
        services: job.services,
      });
    }
  }
  return [...found.values()];
}
