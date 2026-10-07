import { type CardCheck, type CardCommands, detectSecrets } from "@majhi/shared";
import { ciChecks } from "../ci/jobs.ts";
import { readCiFiles } from "../ci/read.ts";
import { chunkDoc } from "../memory/repo-docs.ts";
import { folderName, fsRepoFiles, type RepoFiles } from "./files.ts";

/** What the files of a repo say, before the model or the readiness score. Read by code only. */
export interface ScanFacts {
  stack: string[];
  commands: CardCommands;
  /** The checks the repo's own CI runs, with their environment. */
  checks: CardCheck[];
  structure: { path: string; note: string }[];
  conventions: string[];
  ci: { provider?: string | undefined; workflows: string[] };
  deploy: string[];
  aliases: string[];
  /** The start of the README, for a first "what it is". */
  readme: string;
  /** CLAUDE.md or AGENTS.md exists. */
  agentDocs: boolean;
  /** A lockfile makes a fresh checkout install the same versions. */
  lockfile: boolean;
  /** Reasons a fresh worktree needs a manual step, like submodules or an env template. */
  setupSteps: string[];
}

export interface ScanContext {
  /** The project id and the checkout's folder name, for the alias suggestions. */
  id: string;
  folder: string;
}

const LOCKFILES: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "uv.lock": "uv",
  "poetry.lock": "poetry",
  "Pipfile.lock": "pipenv",
  "Cargo.lock": "cargo",
  "go.sum": "go",
  "Gemfile.lock": "bundler",
  "composer.lock": "composer",
};

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
  ".idea",
  ".vscode",
]);

const DIR_NOTES: Record<string, string> = {
  src: "Source code",
  lib: "Library code",
  app: "Application code",
  apps: "Apps",
  packages: "Shared packages",
  services: "Services",
  cmd: "Command entry points",
  internal: "Internal packages",
  pkg: "Packages",
  test: "Tests",
  tests: "Tests",
  e2e: "End-to-end tests",
  docs: "Documentation",
  doc: "Documentation",
  scripts: "Scripts",
  tools: "Tooling",
  public: "Static files",
  static: "Static files",
  migrations: "Database migrations",
  db: "Database code",
  infra: "Infrastructure",
  terraform: "Infrastructure as code",
  deploy: "Deployment files",
  k8s: "Kubernetes manifests",
  ".github": "GitHub settings and workflows",
  ".gitlab": "GitLab settings",
  ".circleci": "CircleCI settings",
  config: "Configuration",
  design: "Design files",
};

const GENERIC_ALIASES = new Set([
  "app",
  "apps",
  "src",
  "main",
  "root",
  "repo",
  "project",
  "code",
  "api-server",
]);

const CI_FILES: [string, string][] = [
  [".gitlab-ci.yml", "GitLab CI"],
  [".circleci/config.yml", "CircleCI"],
  ["azure-pipelines.yml", "Azure Pipelines"],
  ["bitbucket-pipelines.yml", "Bitbucket Pipelines"],
  ["Jenkinsfile", "Jenkins"],
  [".drone.yml", "Drone"],
  [".travis.yml", "Travis CI"],
  ["cloudbuild.yaml", "Cloud Build"],
];

const DEPLOY_HINTS: [string, string][] = [
  ["vercel.json", "Vercel (vercel.json)"],
  ["netlify.toml", "Netlify (netlify.toml)"],
  ["fly.toml", "Fly.io (fly.toml)"],
  ["render.yaml", "Render (render.yaml)"],
  ["railway.json", "Railway (railway.json)"],
  ["wrangler.toml", "Cloudflare Workers (wrangler.toml)"],
  ["wrangler.jsonc", "Cloudflare Workers (wrangler.jsonc)"],
  ["serverless.yml", "Serverless Framework (serverless.yml)"],
  ["app.yaml", "Google App Engine (app.yaml)"],
  ["Procfile", "Heroku-style Procfile"],
  ["Dockerfile", "Docker image (Dockerfile)"],
  ["docker-compose.yml", "Docker Compose (docker-compose.yml)"],
  ["compose.yaml", "Docker Compose (compose.yaml)"],
  ["firebase.json", "Firebase (firebase.json)"],
];

const FRAMEWORKS: [RegExp, string][] = [
  [/^next$/, "Next.js"],
  [/^react$/, "React"],
  [/^vue$/, "Vue"],
  [/^nuxt$/, "Nuxt"],
  [/^svelte$/, "Svelte"],
  [/^@sveltejs\/kit$/, "SvelteKit"],
  [/^astro$/, "Astro"],
  [/^@remix-run\/react$/, "Remix"],
  [/^express$/, "Express"],
  [/^fastify$/, "Fastify"],
  [/^hono$/, "Hono"],
  [/^@nestjs\/core$/, "NestJS"],
  [/^electron$/, "Electron"],
  [/^vite$/, "Vite"],
  [/^vitest$/, "Vitest"],
  [/^jest$/, "Jest"],
  [/^@playwright\/test$/, "Playwright"],
  [/^tailwindcss$/, "Tailwind CSS"],
  [/^prisma$|^@prisma\/client$/, "Prisma"],
  [/^drizzle-orm$/, "Drizzle"],
  [/^zod$/, "zod"],
];

const PY_FRAMEWORKS: [string, string][] = [
  ["django", "Django"],
  ["fastapi", "FastAPI"],
  ["flask", "Flask"],
  ["sqlalchemy", "SQLAlchemy"],
  ["celery", "Celery"],
  ["pydantic", "Pydantic"],
  ["pytest", "pytest"],
  ["ruff", "Ruff"],
  ["mypy", "mypy"],
  ["pyright", "Pyright"],
];

interface PackageJson {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  workspaces?: unknown;
}

function parsePackage(text: string | undefined): PackageJson | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as PackageJson)
      : undefined;
  } catch {
    return undefined;
  }
}

const version = (v: string | undefined): string =>
  v === undefined ? "" : ` ${v.replace(/^[\^~>=<\s]+/, "")}`;

/** The first of `names` that is one of `scripts`. */
function script(scripts: Record<string, string>, names: readonly string[]): string | undefined {
  return names.find((n) => typeof scripts[n] === "string" && scripts[n] !== "");
}

/** Makefile targets, by name. */
export function makeTargets(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*:(?!=)/gm))
    if (m[1] !== undefined) out.add(m[1]);
  return out;
}

function fillFromMake(commands: CardCommands, targets: Set<string>): void {
  const map: [keyof CardCommands, string[]][] = [
    ["install", ["install", "setup", "deps"]],
    ["run", ["run", "dev", "start", "serve"]],
    ["build", ["build"]],
    ["test", ["test", "check"]],
    ["lint", ["lint"]],
    ["typecheck", ["typecheck", "types"]],
    ["format", ["fmt", "format"]],
  ];
  for (const [key, names] of map) {
    if (commands[key] !== undefined) continue;
    const hit = names.find((n) => targets.has(n));
    if (hit !== undefined) commands[key] = `make ${hit}`;
  }
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[/_.\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");

/** Names the owner might type for a project: the folder, the package names and the repo's name, deduplicated. */
export function suggestAliases(candidates: readonly (string | undefined)[], id: string): string[] {
  const seen = new Set<string>([id.toLowerCase()]);
  const out: string[] = [];
  for (const c of candidates) {
    if (c === undefined) continue;
    const scoped = c.startsWith("@") ? [c, c.split("/")[1]] : [c];
    for (const raw of scoped) {
      const alias = slugify(raw ?? "");
      if (alias.length < 2 || alias.length > 60 || GENERIC_ALIASES.has(alias) || seen.has(alias)) continue;
      seen.add(alias);
      out.push(alias);
    }
  }
  return out.slice(0, 4);
}

/** A text kept only when it holds no secret. */
export function safeText(text: string): string | undefined {
  return detectSecrets(text).length === 0 ? text : undefined;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 4).trimEnd()} ...` : t;
};

/** The paragraph a README opens with, after its title and badges. */
export function readmeStart(text: string | undefined): string {
  if (text === undefined) return "";
  let fence = false;
  const paras: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length > 0) paras.push(cur.join(" "));
    cur = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      flush();
      continue;
    }
    if (fence) continue;
    if (
      line === "" ||
      line.startsWith("#") ||
      line.startsWith("[![") ||
      line.startsWith("![") ||
      line.startsWith("<")
    ) {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  for (const p of paras) {
    if (p.length < 20) continue;
    const text = safeText(clip(p.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"), 400));
    if (text !== undefined) return text;
  }
  return "";
}

export async function scanRepo(files: RepoFiles, ctx: ScanContext): Promise<ScanFacts> {
  const root = await files.list("");
  const has = (name: string) => root.some((e) => e.name === name);
  const stack: string[] = [];
  const commands: CardCommands = {};
  const aliasNames: (string | undefined)[] = [ctx.folder];
  const setupSteps: string[] = [];
  const deploy: string[] = [];

  // Lockfiles
  const lockfiles = root.filter((e) => !e.dir && LOCKFILES[e.name] !== undefined);
  const lockTools = new Set(lockfiles.map((e) => LOCKFILES[e.name] as string));

  // Node
  const pkg = parsePackage(await files.read("package.json"));
  if (pkg !== undefined) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.typescript !== undefined || has("tsconfig.json"))
      stack.push(`TypeScript${version(deps.typescript)}`);
    else stack.push("JavaScript");
    const nvm = (await files.read(".nvmrc"))?.trim() ?? (await files.read(".node-version"))?.trim();
    const node = pkg.engines?.node ?? nvm;
    if (node !== undefined && node !== "") stack.push(`Node ${node.replace(/^[v^~>=<\s]+/, "")}`);
    const pm = pkg.packageManager?.split("@") ?? [];
    const manager =
      pm[0] ??
      (lockTools.has("pnpm")
        ? "pnpm"
        : lockTools.has("yarn")
          ? "yarn"
          : lockTools.has("bun")
            ? "bun"
            : "npm");
    stack.push(pm[1] !== undefined ? `${manager} ${pm[1].split("+")[0]}` : manager);
    for (const [re, label] of FRAMEWORKS) {
      const dep = Object.keys(deps).find((d) => re.test(d));
      if (dep !== undefined) stack.push(`${label}${label === "zod" ? "" : version(deps[dep])}`);
    }
    if (pkg.workspaces !== undefined || has("pnpm-workspace.yaml")) stack.push("monorepo (workspaces)");
    const scripts = pkg.scripts ?? {};
    const run = (name: string) =>
      manager === "yarn" ? `yarn ${name}` : manager === "npm" ? `npm run ${name}` : `${manager} run ${name}`;
    const direct = (name: string) => (name === "test" && manager === "npm" ? "npm test" : run(name));
    commands.install = manager === "npm" ? "npm ci" : `${manager} install`;
    const pick = (key: keyof CardCommands, names: string[]) => {
      const n = script(scripts, names);
      if (n !== undefined) commands[key] = direct(n);
    };
    pick("run", ["dev", "start", "serve"]);
    pick("build", ["build"]);
    pick("test", ["test", "test:unit", "unit"]);
    pick("lint", ["lint", "check"]);
    pick("typecheck", ["typecheck", "type-check", "check-types", "tsc"]);
    pick("format", ["format", "fmt", "prettier"]);
    if (commands.typecheck === undefined && has("tsconfig.json") && deps.typescript !== undefined) {
      commands.typecheck = manager === "npm" ? "npx tsc --noEmit" : `${manager} exec tsc --noEmit`;
    }
    aliasNames.push(pkg.name);
  }

  // Python
  const pyproject = await files.read("pyproject.toml");
  const requirements = await files.read("requirements.txt");
  if (pyproject !== undefined || requirements !== undefined || has("setup.py") || has("Pipfile")) {
    const text = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
    const py =
      /requires-python\s*=\s*"([^"]+)"/.exec(pyproject ?? "")?.[1] ??
      (await files.read(".python-version"))?.trim();
    stack.push(`Python${py === undefined ? "" : ` ${py.replace(/^[><=~!\s]+/, "")}`}`);
    const runner = lockTools.has("uv")
      ? "uv run "
      : lockTools.has("poetry")
        ? "poetry run "
        : lockTools.has("pipenv")
          ? "pipenv run "
          : "";
    stack.push(
      lockTools.has("uv")
        ? "uv"
        : lockTools.has("poetry")
          ? "poetry"
          : lockTools.has("pipenv")
            ? "pipenv"
            : "pip",
    );
    const word = (n: string) => new RegExp(`(^|[^a-z0-9_-])${n}($|[^a-z0-9_-])`).test(text);
    for (const [name, label] of PY_FRAMEWORKS) if (word(name)) stack.push(label);
    const installPy = lockTools.has("uv")
      ? "uv sync"
      : lockTools.has("poetry")
        ? "poetry install"
        : lockTools.has("pipenv")
          ? "pipenv install --dev"
          : requirements !== undefined
            ? "pip install -r requirements.txt"
            : "pip install -e .";
    commands.install ??= installPy;
    const tests = root.some((e) => e.dir && (e.name === "tests" || e.name === "test"));
    if (word("pytest") || text.includes("[tool.pytest") || tests) commands.test ??= `${runner}pytest`;
    if (word("ruff") || text.includes("[tool.ruff")) commands.lint ??= `${runner}ruff check .`;
    else if (word("flake8")) commands.lint ??= `${runner}flake8`;
    if (word("mypy")) commands.typecheck ??= `${runner}mypy .`;
    else if (word("pyright")) commands.typecheck ??= `${runner}pyright`;
    if (word("black")) commands.format ??= `${runner}black .`;
    else if (word("ruff")) commands.format ??= `${runner}ruff format .`;
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(pyproject ?? "")?.[1];
    aliasNames.push(name);
  }

  // Go, Rust, Ruby, PHP, JVM
  const gomod = await files.read("go.mod");
  if (gomod !== undefined) {
    const mod = /^module\s+(\S+)/m.exec(gomod)?.[1];
    const goVersion = /^go\s+(\S+)/m.exec(gomod)?.[1];
    stack.push(`Go${goVersion === undefined ? "" : ` ${goVersion}`}`);
    commands.install ??= "go mod download";
    commands.build ??= "go build ./...";
    commands.test ??= "go test ./...";
    commands.lint ??= "go vet ./...";
    aliasNames.push(mod?.split("/").pop());
  }
  const cargo = await files.read("Cargo.toml");
  if (cargo !== undefined) {
    const edition = /edition\s*=\s*"(\d+)"/.exec(cargo)?.[1];
    stack.push(`Rust${edition === undefined ? "" : ` (edition ${edition})`}`);
    commands.build ??= "cargo build";
    commands.test ??= "cargo test";
    commands.lint ??= "cargo clippy";
    commands.format ??= "cargo fmt";
    aliasNames.push(/^\s*name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1]);
  }
  const gemfile = await files.read("Gemfile");
  if (gemfile !== undefined) {
    stack.push(/gem\s+["']rails["']/.test(gemfile) ? "Ruby on Rails" : "Ruby");
    commands.install ??= "bundle install";
    if (/rspec/.test(gemfile)) commands.test ??= "bundle exec rspec";
    if (/rubocop/.test(gemfile)) commands.lint ??= "bundle exec rubocop";
  }
  if (has("composer.json")) {
    stack.push("PHP");
    commands.install ??= "composer install";
  }
  if (has("pom.xml")) {
    stack.push("Java (Maven)");
    commands.build ??= "mvn package";
    commands.test ??= "mvn test";
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    stack.push("JVM (Gradle)");
    commands.build ??= "./gradlew build";
    commands.test ??= "./gradlew test";
  }

  // Makefile
  const make = await files.read("Makefile");
  if (make !== undefined) fillFromMake(commands, makeTargets(make));

  // CI
  const workflows: string[] = [];
  let provider: string | undefined;
  const wf = await files.list(".github/workflows");
  for (const e of wf) {
    if (e.dir || !/\.ya?ml$/.test(e.name)) continue;
    provider = "GitHub Actions";
    workflows.push(e.name);
    const text = await files.read(`.github/workflows/${e.name}`);
    if (text === undefined) continue;
    if (/\bdeploy\b/i.test(e.name) || /^\s*name:.*deploy/im.test(text))
      deploy.push(`Deploy workflow (${e.name})`);
  }
  for (const [file, label] of CI_FILES) {
    const text = await files.read(file);
    if (text === undefined) continue;
    provider ??= label;
    if (provider === label) workflows.push(file);
  }
  const checks = ciChecks(await readCiFiles(files)).map(
    (c): CardCheck => ({
      kind: c.kind,
      command: c.command,
      env: c.env,
      ...(c.workdir === undefined ? {} : { workdir: c.workdir }),
      from: c.from,
      ...(c.minutes === undefined ? {} : { minutes: c.minutes }),
      services: c.services,
    }),
  );
  for (const c of checks) if (c.workdir === undefined) commands[c.kind] ??= c.command;

  // Deploy hints
  for (const [file, label] of DEPLOY_HINTS) if (has(file)) deploy.push(label);
  for (const dir of ["k8s", "terraform", "helm", "charts"]) {
    if (root.some((e) => e.dir && e.name === dir)) deploy.push(`${dir}/ folder`);
  }

  // Structure
  const structure: { path: string; note: string }[] = [];
  for (const dir of root.filter(
    (e) => e.dir && !IGNORED_DIRS.has(e.name) && (!e.name.startsWith(".") || DIR_NOTES[e.name] !== undefined),
  )) {
    if (structure.length >= 14) break;
    if (["apps", "packages", "services", "libs"].includes(dir.name)) {
      structure.push({ path: `${dir.name}/`, note: DIR_NOTES[dir.name] ?? "Folder" });
      for (const child of (await files.list(dir.name))
        .filter((c) => c.dir && !IGNORED_DIRS.has(c.name))
        .slice(0, 6)) {
        if (structure.length >= 14) break;
        const cp = parsePackage(await files.read(`${dir.name}/${child.name}/package.json`));
        const note =
          cp?.description ?? cp?.name ?? `${(await files.list(`${dir.name}/${child.name}`)).length} entries`;
        structure.push({ path: `${dir.name}/${child.name}/`, note: safeText(clip(note, 80)) ?? "" });
      }
      continue;
    }
    structure.push({
      path: `${dir.name}/`,
      note: DIR_NOTES[dir.name] ?? `${(await files.list(dir.name)).length} entries`,
    });
  }

  // Conventions
  const conventions: string[] = [];
  let agentDocs = false;
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const text = await files.read(file);
    if (text === undefined) continue;
    agentDocs = true;
    for (const chunk of chunkDoc(text).slice(0, 8)) {
      const line = safeText(clip(chunk, 160));
      if (line !== undefined && conventions.length < 8) conventions.push(line);
    }
  }
  if (!agentDocs) {
    const text = await files.read("CONTRIBUTING.md");
    if (text !== undefined) {
      for (const chunk of chunkDoc(text).slice(0, 4)) {
        const line = safeText(clip(chunk, 160));
        if (line !== undefined) conventions.push(line);
      }
    }
  }
  const tools: [string[], string][] = [
    [["biome.json", "biome.jsonc"], "Formatted and linted with Biome"],
    [
      [
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.ts",
        ".eslintrc",
        ".eslintrc.json",
        ".eslintrc.js",
        ".eslintrc.cjs",
      ],
      "Linted with ESLint",
    ],
    [
      [".prettierrc", ".prettierrc.json", "prettier.config.js", ".prettierrc.yaml"],
      "Formatted with Prettier",
    ],
    [[".editorconfig"], "EditorConfig in use"],
    [[".pre-commit-config.yaml", ".husky"], "Commit hooks run checks"],
    [["commitlint.config.js", "commitlint.config.cjs", ".commitlintrc.json"], "Conventional commit messages"],
  ];
  for (const [names, label] of tools) if (names.some(has)) conventions.push(label);
  if (/"strict"\s*:\s*true/.test((await files.read("tsconfig.json")) ?? ""))
    conventions.push("TypeScript strict mode");

  // Setup a fresh worktree needs by hand
  if (has(".gitmodules")) setupSteps.push("git submodules");
  const envTemplate = root.find((e) => !e.dir && /^\.env\.(example|sample|template)$/.test(e.name));
  if (envTemplate !== undefined) setupSteps.push(`an env file copied from ${envTemplate.name}`);

  const readme = readmeStart(await files.read("README.md"));
  const clean = (list: string[]) => [...new Set(list.flatMap((s) => (safeText(s) === undefined ? [] : [s])))];
  const safeCommands: CardCommands = {};
  for (const [k, v] of Object.entries(commands)) {
    if (typeof v === "string" && safeText(v) !== undefined)
      safeCommands[k as keyof CardCommands] = clip(v, 140);
  }
  return {
    stack: clean(stack),
    commands: safeCommands,
    checks: checks.filter((c) => safeText(c.command) !== undefined),
    structure,
    conventions: clean(conventions),
    ci: { ...(provider === undefined ? {} : { provider }), workflows },
    deploy: clean(deploy),
    aliases: suggestAliases(aliasNames, ctx.id),
    readme,
    agentDocs,
    lockfile: lockfiles.length > 0,
    setupSteps,
  };
}

/** The files whose change makes the card stale. A change anywhere else leaves it as it is. */
export function isCardRelevant(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (name in LOCKFILES) return true;
  if (
    /^(package\.json|pyproject\.toml|requirements.*\.txt|setup\.py|Pipfile|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|Makefile|Dockerfile|tsconfig.*\.json|pnpm-workspace\.yaml)$/.test(
      name,
    )
  )
    return true;
  if (/^(README|CLAUDE|AGENTS|CONTRIBUTING)\.md$/i.test(name)) return true;
  if (path.startsWith(".github/workflows/") || CI_FILES.some(([f]) => f === path)) return true;
  if (DEPLOY_HINTS.some(([f]) => f === path)) return true;
  if (
    /^(biome\.jsonc?|\.eslintrc.*|eslint\.config\..*|\.prettierrc.*|\.editorconfig|\.nvmrc|\.node-version|\.python-version|\.gitmodules|\.env\.(example|sample|template))$/.test(
      name,
    )
  )
    return true;
  // A top-level folder appearing or going changes the structure; a file deep inside one does not.
  return false;
}

/** Aliases for a repo that is not registered yet, from its folder and package names. */
export async function suggestRepoAliases(path: string, id: string): Promise<string[]> {
  try {
    return (await scanRepo(fsRepoFiles(path), { id, folder: folderName(path) })).aliases;
  } catch {
    return [];
  }
}
