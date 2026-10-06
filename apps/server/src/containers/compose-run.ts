import type { TaskDockerErrorCode, TaskDockerResult } from "@majhi/shared";
import { ContainerRefused, type Safety, shown } from "./args.ts";
import { type ComposeProject, type ComposeService, loadCompose } from "./compose.ts";
import type { ComposeInvocation } from "./compose-cli.ts";
import { containerNames } from "./names.ts";
import {
  buildRunPlan,
  ImageNotAllowed,
  localImage,
  showUserNames,
  type TaskDockerContext,
  type TaskDockerPlan,
  translateTaskDocker,
} from "./task-docker.ts";

/**
 * `docker compose up | down | ps | logs | exec` of a task. The compose file is a plan
 * (`compose.ts`); this runs it with the pieces `docker run` already has, so a compose service is a
 * task container like any other: the same holder and guard, the same names, labels, limits and
 * approvals. `ComposeHost` is what the container service lends it.
 */
export interface ComposeHost {
  task: string;
  safety: Safety;
  /** `containers.per_task`: the most containers a task runs. */
  perTask: number;
  /** Where the script ran. */
  cwd: string;
  /** The checked context for a call from `dir`: allowed images, images built so far. */
  context(dir: string): Promise<TaskDockerContext>;
  /** Throws `ContainerRefused` (`limit_reached`) unless the task may run `extra` more containers. */
  checkLimits(extra: number): Promise<void>;
  /** Asks the owner for an image, naming the service. */
  ask(image: string, service?: string): Promise<"allowed" | "pending">;
  /** Throws `ImageNotAllowed` when the Dockerfile of a build call pulls an image the task may not run. */
  checkBuild(args: string[]): Promise<void>;
  /** `docker buildx build`, as the plan of a `docker build` has it. */
  build(args: string[]): Promise<TaskDockerResult>;
  /** Holder, then container. */
  launch(plan: Extract<TaskDockerPlan, { kind: "run" }>): Promise<TaskDockerResult>;
  /** A checked call of the task's own: `rm`, `logs`, `exec`. */
  call(args: string[]): Promise<TaskDockerResult>;
  /** A read of docker's state (`ps`, `inspect`). */
  read(args: string[]): Promise<string>;
  removeVolumes(names: string[]): Promise<void>;
  /** Removes the holders whose container is gone. */
  reap(): Promise<void>;
  /** How long to wait between looks at a container's state. Default 500. */
  pollMs?: number | undefined;
  /** How long `depends_on` waits for a condition. Default 5 minutes. */
  waitMs?: number | undefined;
}

const ok = (stdout: string, stderr = ""): TaskDockerResult => ({ code: 0, stdout, stderr });

function fail(host: ComposeHost, code: TaskDockerErrorCode, message: string): TaskDockerResult {
  const shownMessage = showUserNames(host.task, message);
  return {
    code: 1,
    stdout: "",
    stderr: `docker: [${code}] ${shownMessage}\n`,
    error: { code, message: shownMessage },
  };
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** One service's container, `majhi-<key>-c-<name>`, as docker names it. */
const containerOf = (host: ComposeHost, service: string): string =>
  containerNames(host.task).service(service);

/** The compose containers of the task by name, running or not, with their state. */
async function composeContainers(
  host: ComposeHost,
  all: boolean,
): Promise<{ name: string; service: string; image: string; status: string }[]> {
  const text = await host.read([
    "ps",
    ...(all ? ["-a"] : []),
    "--filter",
    "label=majhi.container=taskrun",
    "--filter",
    `label=majhi.task=${host.task}`,
    "--filter",
    "label=majhi.compose",
    "--format",
    '{{.Names}}\t{{.Label "majhi.compose"}}\t{{.Image}}\t{{.Status}}',
  ]);
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const [name = "", service = "", image = "", status = ""] = line.split("\t");
      return { name, service, image, status };
    });
}

/** A container's state: its status, exit code and health (`none` when it has no health check). */
async function stateOf(
  host: ComposeHost,
  container: string,
): Promise<{ status: string; exit: number; health: string } | undefined> {
  try {
    const text = await host.read([
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
      container,
    ]);
    const [status = "", exit = "0", health = "none"] = text.trim().split(" ");
    return { status, exit: Number(exit), health };
  } catch {
    return undefined;
  }
}

/** Waits for what a service needs of the one it depends on. Returns the reason it cannot be had, or undefined. */
async function waitDependency(
  host: ComposeHost,
  service: ComposeService,
  dependency: ComposeService,
  condition: "started" | "healthy" | "completed",
): Promise<string | undefined> {
  if (condition === "started") return undefined;
  const container = containerOf(host, dependency.name);
  const deadline = Date.now() + (host.waitMs ?? 5 * 60_000);
  while (Date.now() < deadline) {
    const state = await stateOf(host, container);
    if (state === undefined) return `${dependency.name} is not running.`;
    if (condition === "healthy") {
      if (state.health === "healthy") return undefined;
      if (state.health === "none" && state.status === "running") return undefined;
      if (state.status !== "running") {
        return `${dependency.name} stopped (exit ${state.exit}) before it was healthy. Read why with docker compose logs ${dependency.name}.`;
      }
    } else if (state.status === "exited") {
      return state.exit === 0
        ? undefined
        : `${dependency.name} exited with code ${state.exit}. Read why with docker compose logs ${dependency.name}.`;
    }
    await sleep(host.pollMs ?? 500);
  }
  return `${service.name} waited for ${dependency.name} to be ${condition === "healthy" ? "healthy" : "done"} and it was not in time.`;
}

/** The services of the project that run now, by name. */
async function running(host: ComposeHost): Promise<Set<string>> {
  return new Set((await composeContainers(host, false)).map((c) => c.service));
}

/** The checked `docker buildx build` call of a service's `build:`. Throws when the build is refused. */
function buildArgsOf(build: NonNullable<ComposeService["build"]>, ctx: TaskDockerContext): string[] {
  const plan = translateTaskDocker(
    [
      "build",
      "--tag",
      build.tag,
      "--file",
      build.dockerfile,
      ...(build.target === undefined ? [] : ["--target", build.target]),
      ...build.args.flatMap((a) => ["--build-arg", a]),
      build.context,
    ],
    ctx,
  );
  if (plan.kind !== "build") throw new ContainerRefused("The build was not understood.");
  return plan.args;
}

async function up(
  host: ComposeHost,
  inv: ComposeInvocation,
  project: ComposeProject,
): Promise<TaskDockerResult> {
  const ctx = await host.context(inv.cwd);
  // Everything is checked before anything starts: a refusal leaves the task as it was.
  const missing: ImageNotAllowed[] = [];
  for (const service of project.services) {
    const future =
      service.build === undefined
        ? ctx.builtImages
        : new Set([...ctx.builtImages, localImage(host.task, service.build.tag) ?? ""]);
    try {
      buildRunPlan(service.spec, { ...ctx, builtImages: future });
    } catch (err) {
      if (err instanceof ImageNotAllowed) missing.push(err);
      else throw err;
    }
    if (service.build !== undefined) {
      try {
        await host.checkBuild(buildArgsOf(service.build, ctx));
      } catch (err) {
        if (err instanceof ImageNotAllowed)
          missing.push(new ImageNotAllowed(err.image, service.name, err.also));
        else throw err;
      }
    }
  }
  if (missing.length > 0) {
    const wanted = missing.flatMap((m) =>
      [m.image, ...m.also].map((image) => ({ image, service: m.service })),
    );
    const answers = await Promise.all(
      wanted.map((m) => host.ask(m.image, m.service).catch(() => "pending" as const)),
    );
    const list = wanted.map((m) => `${m.service ?? "?"}: ${m.image}`).join(", ");
    return fail(
      host,
      "image_not_allowed",
      answers.every((a) => a === "allowed")
        ? `The owner allowed ${list}. Run docker compose up again.`
        : `Images not allowed yet: ${list}. majhi asked the owner in the room. Run docker compose up again after the answer.`,
    );
  }
  const now = await running(host);
  const starting = project.services.filter((s) => !now.has(s.name));
  const lines: string[] = [];
  const stderr = [...inv.notes, ...project.notes].map((n) => `docker: ${n}\n`);
  const all = await composeContainers(host, true);
  if (starting.length > 0) {
    try {
      await host.checkLimits(starting.length);
    } catch (err) {
      if (err instanceof ContainerRefused) return fail(host, err.refusal, err.message);
      throw err;
    }
  }
  for (const service of project.services) {
    if (now.has(service.name)) {
      lines.push(` Container ${service.name}  Running`);
      continue;
    }
    for (const d of service.dependsOn) {
      const dependency = project.services.find((s) => s.name === d.service);
      if (dependency === undefined) continue;
      const why = await waitDependency(host, service, dependency, d.condition);
      if (why !== undefined) return fail(host, "compose_dependency_failed", why);
    }
    if (service.build !== undefined) {
      const buildArgs = buildArgsOf(service.build, ctx);
      const built = await host.build(buildArgs);
      if (built.code !== 0) {
        return {
          code: built.code,
          stdout: [...lines, ""].join("\n") + built.stdout,
          stderr: `${stderr.join("")}${built.stderr}docker: [refused] building ${service.name} failed.\n`,
        };
      }
      lines.push(` Image ${service.name}  Built`);
    }
    // A container of this name that ended (a job that finished, a crash) is replaced.
    if (all.some((c) => c.name === containerOf(host, service.name))) {
      await host.call(["rm", "-f", "-v", containerOf(host, service.name)]);
    }
    const plan = buildRunPlan(service.spec, await host.context(inv.cwd));
    const launched = await host.launch(plan);
    if (launched.code !== 0) {
      return {
        code: launched.code,
        stdout: `${lines.join("\n")}\n${launched.stdout}`,
        stderr: `${stderr.join("")}${launched.stderr}`,
        ...(launched.error === undefined ? {} : { error: launched.error }),
      };
    }
    stderr.push(...plan.notes.map((n) => `docker: ${n}\n`));
    lines.push(` Container ${service.name}  Started`);
    for (const port of service.ports)
      stderr.push(
        `docker: ${service.name}: reach it from this task at ${service.name}:${port}. Nothing is published on the computer.\n`,
      );
  }
  if (inv.wait) {
    for (const service of project.services) {
      const why = await waitDependency(
        host,
        service,
        service,
        service.hasHealthcheck ? "healthy" : "started",
      );
      if (why !== undefined) return fail(host, "compose_dependency_failed", why);
    }
  }
  if (project.services.length === 0) lines.push("No services to start.");
  return ok(`${lines.join("\n")}\n`, stderr.join(""));
}

async function down(host: ComposeHost, inv: ComposeInvocation): Promise<TaskDockerResult> {
  const containers = await composeContainers(host, true);
  const wanted = inv.services.map((s) => s.toLowerCase());
  const chosen = containers.filter((c) => wanted.length === 0 || wanted.includes(c.service));
  const lines: string[] = [];
  if (chosen.length > 0) {
    const removed = await host.call(["rm", "-f", "-v", ...chosen.map((c) => c.name)]);
    if (removed.code !== 0) return removed;
    for (const c of chosen) lines.push(` Container ${c.service}  Removed`);
  }
  await host.reap();
  if (inv.volumes && wanted.length === 0) {
    const names = containerNames(host.task);
    try {
      const ctx = await host.context(inv.cwd);
      const project = await loadCompose(inv, ctx);
      await host.removeVolumes(project.volumes.map((v) => names.volume(v)));
      for (const v of project.volumes) lines.push(` Volume ${v}  Removed`);
    } catch (err) {
      // No compose file left to name the volumes: the containers are gone, which is what down is for.
      if (!(err instanceof ContainerRefused)) throw err;
    }
  }
  return ok(lines.length === 0 ? "Nothing to remove.\n" : `${lines.join("\n")}\n`);
}

async function ps(host: ComposeHost, inv: ComposeInvocation): Promise<TaskDockerResult> {
  const wanted = inv.services.map((s) => s.toLowerCase());
  const rows = (await composeContainers(host, inv.all)).filter(
    (c) => wanted.length === 0 || wanted.includes(c.service),
  );
  if (inv.servicesOnly) return ok(rows.map((r) => `${r.service}\n`).join(""));
  if (inv.quiet) return ok(rows.map((r) => `${r.name}\n`).join(""));
  const shownRows = rows.map((r) => [r.service, showUserNames(host.task, r.image), r.status]);
  const width = (i: number) =>
    Math.max(...[["SERVICE", "IMAGE", "STATUS"], ...shownRows].map((r) => (r[i] ?? "").length));
  const line = (r: string[]) =>
    r
      .map((cell, i) => cell.padEnd(width(i)))
      .join("  ")
      .trimEnd();
  return ok(`${[line(["SERVICE", "IMAGE", "STATUS"]), ...shownRows.map(line)].join("\n")}\n`);
}

async function logs(host: ComposeHost, inv: ComposeInvocation): Promise<TaskDockerResult> {
  const wanted = inv.services.map((s) => s.toLowerCase());
  const rows = (await composeContainers(host, true)).filter(
    (c) => wanted.length === 0 || wanted.includes(c.service),
  );
  if (rows.length === 0) return ok("No containers.\n");
  let stdout = "";
  for (const row of rows) {
    const out = await host.call([
      "logs",
      ...(inv.timestamps ? ["--timestamps"] : []),
      "--tail",
      inv.tail ?? "all",
      row.name,
    ]);
    // docker keeps a container's two streams apart; each line says whose it is, as compose's output does.
    const prefix = (text: string) =>
      text
        .split("\n")
        .filter((l, i, a) => l !== "" || i < a.length - 1)
        .map((l) => `${row.service}  | ${l}\n`)
        .join("");
    stdout += prefix(out.stdout) + prefix(out.stderr);
  }
  return ok(stdout, "");
}

async function exec(host: ComposeHost, inv: ComposeInvocation): Promise<TaskDockerResult> {
  const service = (inv.services[0] ?? "").toLowerCase();
  const rows = await composeContainers(host, false);
  if (!rows.some((c) => c.service === service)) {
    return fail(
      host,
      "refused",
      `Service ${shown(service)} is not running. Start it with docker compose up -d ${service}.`,
    );
  }
  return host.call([
    "exec",
    ...inv.env.flatMap((e) => ["--env", e]),
    ...(inv.workdir === undefined ? [] : ["--workdir", inv.workdir]),
    containerOf(host, service),
    ...inv.command,
  ]);
}

/** Runs one compose command of a task. A refusal throws `ContainerRefused` with its code. */
export async function composeCall(host: ComposeHost, inv: ComposeInvocation): Promise<TaskDockerResult> {
  switch (inv.verb) {
    case "up": {
      const ctx = await host.context(inv.cwd);
      return up(host, inv, await loadCompose(inv, ctx));
    }
    case "down":
      return down(host, inv);
    case "ps":
      return ps(host, inv);
    case "logs":
      return logs(host, inv);
    case "exec":
      return exec(host, inv);
  }
}
