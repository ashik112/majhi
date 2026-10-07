import type { WikiDeployJob } from "@majhi/shared";
import { z } from "zod";
import { wordsOf } from "../system/resolver.ts";
import type { ScanContext } from "./context.ts";
import { type PlatformFile, TARGET_WORDS, type TextFile } from "./deploy-files.ts";
import { exposedPorts, finalImage, splitSpaces } from "./formats.ts";
import { baseOf, dirOf, type KubeFile } from "./read.ts";
import { addDeploy, clip } from "./scan-ci.ts";
import type { Cite } from "./sink.ts";

/**
 * Every other file that shows how a repo is deployed: a host's config file, Dockerfiles and compose files, Helm
 * charts, Kustomize folders, Argo CD and Flux objects, Kubernetes manifests, Makefile targets, deploy scripts and
 * deploy documents. CI pipelines are in `scan-ci.ts`. Names only: a command or a value is never copied.
 */

const here = (path: string, line = 1): Cite => ({ path, lines: [line, line] });

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// Hosts -------------------------------------------------------------------------------------------

/** One short line on what a host's config file sets up, from its own fields. Undefined when it has nothing to say. */
export function platformNote(file: PlatformFile): string | undefined {
  const data = record(file.data);
  const parts: string[] = [];
  switch (baseOf(file.path)) {
    case "vercel.json": {
      const framework = text(data.framework);
      if (framework !== undefined) parts.push(`framework ${framework}`);
      const git = record(data.git).deploymentEnabled;
      if (git === false) parts.push("deploys from git are off");
      else if (typeof git === "object" && git !== null) {
        parts.push(
          `deploys from git by branch: ${Object.entries(git)
            .map(([b, on]) => `${b} ${on === false ? "off" : "on"}`)
            .join(", ")}`,
        );
      }
      if (Array.isArray(data.crons)) parts.push(`${data.crons.length} cron jobs`);
      break;
    }
    case "firebase.json": {
      const hosting = data.hosting;
      const sites = (Array.isArray(hosting) ? hosting : hosting === undefined ? [] : [hosting]).map((h) => {
        const o = record(h);
        return text(o.site) ?? text(o.target) ?? text(o.public) ?? "site";
      });
      const targets = ["hosting", "functions", "firestore", "storage", "database", "apphosting"].filter(
        (k) => data[k] !== undefined,
      );
      if (targets.length > 0) parts.push(`deploys ${targets.join(", ")}`);
      if (sites.length > 0) parts.push(`hosting sites ${sites.join(", ")}`);
      break;
    }
    case "fly.toml": {
      const app = text(data.app);
      if (app !== undefined) parts.push(`app ${app}`);
      const deploy = record(data.deploy);
      const release = text(deploy.release_command);
      if (release !== undefined) parts.push(`release command ${release}`);
      const strategy = text(deploy.strategy);
      if (strategy !== undefined) parts.push(`strategy ${strategy}`);
      break;
    }
    case "wrangler.toml":
    case "wrangler.json":
    case "wrangler.jsonc": {
      const worker = text(data.name);
      if (worker !== undefined) parts.push(`worker ${worker}`);
      const envs = Object.keys(record(data.env));
      if (envs.length > 0) parts.push(`environments ${envs.join(", ")}`);
      break;
    }
    case "netlify.toml": {
      const build = record(data.build);
      const command = text(build.command);
      if (command !== undefined) parts.push(`build command ${command}`);
      const contexts = Object.keys(record(data.context));
      if (contexts.length > 0) parts.push(`contexts ${contexts.join(", ")}`);
      break;
    }
    case "render.yaml": {
      const services = (Array.isArray(data.services) ? data.services : []).map(record);
      const listed = services.flatMap((s) => {
        const name = text(s.name);
        return name === undefined ? [] : [`${name}${s.autoDeploy === false ? " (manual deploy)" : ""}`];
      });
      if (listed.length > 0) parts.push(`services ${listed.join(", ")}`);
      const pre = services.flatMap((s) =>
        text(s.preDeployCommand) === undefined ? [] : [text(s.name) ?? "service"],
      );
      if (pre.length > 0) parts.push(`pre-deploy command on ${pre.join(", ")}`);
      break;
    }
    case "Procfile": {
      const processes = file.text.split("\n").flatMap((line) => {
        const colon = line.indexOf(":");
        return colon > 0 && !line.startsWith("#") ? [line.slice(0, colon).trim()] : [];
      });
      if (processes.length > 0) parts.push(`processes ${processes.join(", ")}`);
      break;
    }
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

const says = (comment: string | undefined): string | undefined =>
  comment === undefined ? undefined : `its first comment says "${comment}"`;

function scanPlatforms(ctx: ScanContext): void {
  for (const file of ctx.deploy.platforms) {
    addDeploy(ctx, {
      system: "platform",
      name: file.label,
      slug: `platform:${file.path}`,
      cites: [here(file.path)],
      note: [`config file ${file.path}`, platformNote(file), says(headerComment(file))]
        .filter((p) => p !== undefined)
        .join("; "),
    });
  }
}

// Images and compose files ------------------------------------------------------------------------

function scanDocker(ctx: ScanContext): void {
  for (const file of ctx.deploy.dockerfiles) {
    const stages = file.instructions.filter((i) => i.name === "FROM").length;
    const image = finalImage(file.instructions);
    const ports = [...new Set(exposedPorts(file.instructions).map((p) => p.port))];
    addDeploy(ctx, {
      system: "docker",
      name: file.path,
      slug: `docker:${file.path}`,
      cites: [here(file.path, file.instructions[0]?.line ?? 1)],
      note: [
        image === undefined ? undefined : `image from ${image}`,
        stages > 1 ? `${stages} build stages` : undefined,
        ports.length > 0 ? `exposes ${ports.join(", ")}` : undefined,
      ]
        .filter((p) => p !== undefined)
        .join("; "),
    });
  }
  for (const file of ctx.scan.compose) {
    const services = Object.keys(file.data.services ?? {});
    addDeploy(ctx, {
      system: "docker",
      name: file.path,
      slug: `docker:${file.path}`,
      cites: [here(file.path, file.located.lineOf(["services"]) ?? 1)],
      note: `compose services ${services.join(", ")}`,
    });
  }
}

// Helm, Kustomize, Argo CD, Flux, manifests -------------------------------------------------------

/** A repository address without credentials, for a note. */
function repoName(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return raw.includes("@") && !raw.includes("://") ? (raw.split("@").at(-1) ?? raw) : raw;
  }
}

const GITOPS_GROUPS = [
  "argoproj.io",
  "kustomize.toolkit.fluxcd.io",
  "helm.toolkit.fluxcd.io",
  "source.toolkit.fluxcd.io",
];

const Meta = z.looseObject({ name: z.string().optional().catch(undefined) });
const GitopsDoc = z.looseObject({
  apiVersion: z.string(),
  kind: z.string(),
  metadata: Meta.optional().catch(undefined),
  spec: z.looseObject({}).optional().catch(undefined),
});

/** A line on one Argo CD or Flux object: where it takes its manifests from, and whether it syncs by itself. */
function gitopsNote(kind: string, spec: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (kind === "Application") {
    const source = record(spec.source);
    const repo = text(source.repoURL);
    if (repo !== undefined) parts.push(`takes from ${repoName(repo)}`);
    for (const key of ["path", "targetRevision", "chart"]) {
      const v = text(source[key]);
      if (v !== undefined) parts.push(`${key} ${v}`);
    }
    const namespace = text(record(spec.destination).namespace);
    if (namespace !== undefined) parts.push(`namespace ${namespace}`);
    parts.push(record(spec.syncPolicy).automated === undefined ? "synced by hand" : "syncs by itself");
  } else if (kind === "ApplicationSet") {
    parts.push(
      `generators ${Object.keys(record((Array.isArray(spec.generators) ? spec.generators : [])[0])).join(", ")}`,
    );
  } else if (kind === "Kustomization") {
    const path = text(spec.path);
    if (path !== undefined) parts.push(`path ${path}`);
    const from = text(record(spec.sourceRef).name);
    if (from !== undefined) parts.push(`from ${from}`);
  } else if (kind === "GitRepository") {
    const url = text(spec.url);
    if (url !== undefined) parts.push(`watches ${repoName(url)}`);
    const branch = text(record(spec.ref).branch);
    if (branch !== undefined) parts.push(`branch ${branch}`);
  } else if (kind === "HelmRelease") {
    const chart = text(record(record(spec.chart).spec).chart);
    if (chart !== undefined) parts.push(`chart ${chart}`);
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

function scanKubeFile(ctx: ScanContext, file: KubeFile): void {
  if (file.values) return;
  const loose: string[] = [];
  for (const doc of file.docs) {
    const parsed = GitopsDoc.safeParse(doc.data);
    if (!parsed.success) continue;
    const { apiVersion, kind, metadata, spec } = parsed.data;
    const name = metadata?.name ?? kind;
    if (GITOPS_GROUPS.some((g) => apiVersion.startsWith(g))) {
      const line = doc.lineOf(["kind"]) ?? 1;
      addDeploy(ctx, {
        system: "gitops",
        name: `${kind} ${name}`,
        slug: `gitops:${file.path}#${kind}-${name}`,
        cites: [here(file.path, line)],
        note: gitopsNote(kind, record(spec)),
      });
    } else loose.push(`${kind} ${name}`);
  }
  if (loose.length > 0) {
    addDeploy(ctx, {
      system: "gitops",
      name: file.path,
      slug: `gitops:${file.path}`,
      cites: [here(file.path)],
      note: `Kubernetes manifests: ${loose.join(", ")}`,
    });
  }
}

function scanGitops(ctx: ScanContext): void {
  for (const file of ctx.scan.kube.slice(0, 40)) scanKubeFile(ctx, file);
  for (const chart of ctx.deploy.charts) {
    const dir = dirOf(chart.path);
    const values = ctx.scan.paths
      .filter(
        (p) =>
          dirOf(p) === dir && baseOf(p).startsWith("values") && (p.endsWith(".yaml") || p.endsWith(".yml")),
      )
      .map(baseOf);
    addDeploy(ctx, {
      system: "gitops",
      name: `Helm chart ${chart.name ?? (dir === "" ? "." : dir)}`,
      slug: `gitops:${chart.path}`,
      cites: [here(chart.path)],
      note: values.length === 0 ? undefined : `values files ${values.join(", ")}`,
    });
  }
  for (const path of ctx.scan.paths
    .filter((p) => baseOf(p) === "kustomization.yaml" || baseOf(p) === "kustomization.yml")
    .slice(0, 15)) {
    const dir = dirOf(path);
    const overlay = baseOf(dirOf(dir)) === "overlays";
    addDeploy(ctx, {
      system: "gitops",
      name: `Kustomize ${overlay ? "overlay" : "folder"} ${dir === "" ? "." : dir}`,
      slug: `gitops:${path}`,
      cites: [here(path)],
    });
  }
}

// Make, scripts, documents ------------------------------------------------------------------------

/** The targets of a Makefile that deploy, release, migrate or push, with what each needs first and the line it starts at. */
export function deployTargets(source: string): { job: WikiDeployJob; line: number }[] {
  const out: { job: WikiDeployJob; line: number }[] = [];
  source.split("\n").forEach((raw, i) => {
    const first = raw[0];
    if (first === undefined || first === "\t" || first === " " || first === "#" || first === ".") return;
    const colon = raw.indexOf(":");
    if (colon <= 0 || raw[colon + 1] === "=") return;
    const left = raw.slice(0, colon);
    if (left.includes("=") || left.includes("$")) return;
    const rest = raw.slice(colon + 1).split(";")[0] ?? "";
    const needs = splitSpaces(rest.split("#")[0] ?? "").filter((n) => n !== "|");
    for (const target of splitSpaces(left)) {
      if (wordsOf(target).some((w) => TARGET_WORDS.has(w))) {
        out.push({
          job: {
            name: clip(target, 80),
            needs: needs.slice(0, 8).map((n) => clip(n, 80)),
            manual: false,
            inputs: [],
          },
          line: i + 1,
        });
      }
    }
  });
  return out;
}

function scanMake(ctx: ScanContext): void {
  for (const file of ctx.deploy.makefiles) {
    const targets = deployTargets(file.text);
    if (targets.length === 0) continue;
    addDeploy(ctx, {
      system: "make",
      name: file.path,
      slug: `make:${file.path}`,
      cites: targets.map((t) => here(file.path, t.line)),
      jobs: targets.map((t) => t.job),
    });
  }
}

/** The first line of a script that is a comment, past a shebang: what the author says it is for. */
export function headerComment(file: TextFile): string | undefined {
  for (const raw of file.text.split("\n").slice(0, 12)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#!")) continue;
    for (const mark of ["#", "//", "--"]) {
      if (line.startsWith(mark)) {
        const said = line.slice(mark.length).trim();
        return said === "" ? undefined : said;
      }
    }
    return undefined;
  }
  return undefined;
}

/** The first heading of a document, or its first line. */
export function documentTitle(file: TextFile): string | undefined {
  for (const raw of file.text.split("\n").slice(0, 30)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("---") || line === "===") continue;
    const title = line.startsWith("#") ? line.split("#").join("").trim() : line;
    return title === "" ? undefined : title;
  }
  return undefined;
}

function scanScripts(ctx: ScanContext): void {
  for (const file of ctx.deploy.scripts) {
    addDeploy(ctx, {
      system: "script",
      name: file.path,
      slug: `script:${file.path}`,
      cites: [here(file.path)],
      note: headerComment(file),
    });
  }
  for (const file of ctx.deploy.docs) {
    addDeploy(ctx, {
      system: "doc",
      name: file.path,
      slug: `doc:${file.path}`,
      cites: [here(file.path)],
      note: documentTitle(file),
    });
  }
}

export function scanDeploy(ctx: ScanContext): void {
  scanPlatforms(ctx);
  scanDocker(ctx);
  scanGitops(ctx);
  scanMake(ctx);
  scanScripts(ctx);
}
