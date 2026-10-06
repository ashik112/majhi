import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Four small Acme projects that link to each other the way real ones do: a web app that calls an API, an
 * API with a database and a queue, a worker that takes jobs and uses a shared library. Generic names only.
 */
export const FIXTURE_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "acme-web": {
    "package.json": JSON.stringify(
      {
        name: "acme-web",
        private: true,
        scripts: { start: "next start" },
        dependencies: { next: "15.0.0", react: "19.0.0", stripe: "^17.0.0" },
      },
      null,
      2,
    ),
    ".env.example": "# Where the API lives\nACME_API_URL=https://api.acme.test/v2\nNEXT_PUBLIC_NAME=Acme\n",
    "vercel.json": "{}\n",
  },
  "acme-api": {
    "pyproject.toml": [
      "[project]",
      'name = "acme-api"',
      "dependencies = [",
      '  "django>=5",',
      '  "psycopg2-binary",',
      '  "redis>=5",',
      "]",
      "",
    ].join("\n"),
    Dockerfile: 'FROM python:3.13-slim\nEXPOSE 8000\nCMD ["gunicorn"]\n',
    "docker-compose.yml": [
      "services:",
      "  api:",
      "    build: .",
      "    depends_on:",
      "      - db",
      "      - redis",
      "    environment:",
      "      DATABASE_URL: postgres://acme:secretpw@db:5432/orders",
      "      REDIS_URL: redis://redis:6379/0",
      "  db:",
      "    image: postgres:16",
      "  redis:",
      "    image: redis:7",
      "",
    ].join("\n"),
    ".env.example":
      "DATABASE_URL=postgres://acme:secretpw@localhost:5432/orders\nSTRIPE_SECRET_KEY=sk_test_abc\n",
    "src/jobs.py":
      'import redis\nimport requests\n\nqueue = redis.Redis()\n\n\ndef send(payload):\n    queue.lpush("image-jobs", payload)\n    requests.post("https://thumbs.acme.test/make", json=payload)\n',
  },
  "acme-worker": {
    "package.json": JSON.stringify(
      {
        name: "acme-worker",
        scripts: { start: "node dist/main.js" },
        dependencies: { bullmq: "^5.0.0", "worker-kit": "^1.20.0" },
      },
      null,
      2,
    ),
    ".env.example": "ACME_API_URL=http://api:8000/jobs/done\n",
  },
  "worker-kit": {
    "package.json": JSON.stringify({ name: "worker-kit", version: "1.20.0", main: "dist/index.js" }, null, 2),
  },
};

/**
 * Eight Acme and Globex projects that reproduce what made a real map wrong: a third-party API, a list of
 * allowed origins, a variable name with no URL, `localhost:8000` in two projects, two projects that each run
 * their own Postgres, two that really share one queue (the same remote URL), and projects with no link at all.
 */
export const ACCURACY_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "acme-web": {
    "package.json": JSON.stringify(
      {
        name: "acme-web",
        scripts: { start: "next start" },
        dependencies: { next: "15.0.0", react: "19.0.0" },
      },
      null,
      2,
    ),
    ".env.example": [
      "ACME_API_URL=https://api.acme.test/",
      "PARTS_API_BASE=https://api.partsco.test/",
      "VITE_PARENT_ORIGINS=https://front.acme.test,https://stg.acme.test",
      "CORS_ALLOWED_ORIGIN=https://front.acme.test",
      "SENTRY_DSN=https://abc@o1.ingest.sentry.io/1",
      "",
    ].join("\n"),
  },
  "acme-admin": {
    "package.json": JSON.stringify(
      {
        name: "acme-admin",
        scripts: { start: "vite preview" },
        dependencies: { vite: "6.0.0", react: "19.0.0" },
      },
      null,
      2,
    ),
    ".env.example": "VITE_API_URL=https://api.acme.test/\nVITE_PARENT_ORIGINS=https://front.acme.test\n",
  },
  "acme-api": {
    "pyproject.toml": [
      "[project]",
      'name = "acme-api"',
      'dependencies = ["django>=5", "psycopg2-binary", "redis>=5", "openai"]',
      "",
    ].join("\n"),
    "docker-compose.yml": ["services:", "  api:", "    build: .", ""].join("\n"),
    ".env.example": [
      "DATABASE_URL=postgres://acme@localhost:5432/app",
      "BASE_URL=http://localhost:8000/",
      "RESEND_EMAIL_VERIFICATION_PER_HOUR_USER_LIMIT=5",
      "",
    ].join("\n"),
    "src/client.py": "import requests\n\n\ndef fetch(url):\n    return requests.get(url)\n",
  },
  "acme-billing": {
    "pyproject.toml": [
      "[project]",
      'name = "acme-billing"',
      'dependencies = ["fastapi", "psycopg2-binary"]',
      "",
    ].join("\n"),
    ".env.example": [
      "DATABASE_URL=postgres://billing@localhost:5432/app",
      "BASE_URL=http://localhost:8000/",
      "ACME_API_URL=http://api:8000/",
      "",
    ].join("\n"),
    "src/client.py": [
      "import requests",
      "",
      "",
      "def sync(order):",
      '    requests.post("http://api:8000/orders", json=order)',
      '    requests.post("https://reports.acme.test/v1/push", json=order)',
      "    return requests.get(order.url)",
      "",
    ].join("\n"),
  },
  "acme-worker": {
    "package.json": JSON.stringify(
      { name: "acme-worker", scripts: { start: "node dist/main.js" }, dependencies: { bullmq: "^5.0.0" } },
      null,
      2,
    ),
    ".env.example": "REDIS_URL=redis://queue.acme.test:6379/0\n",
  },
  "acme-jobs": {
    "pyproject.toml": ["[project]", 'name = "acme-jobs"', 'dependencies = ["celery", "redis"]', ""].join(
      "\n",
    ),
    ".env.example": "BROKER_URL=redis://queue.acme.test:6379/0\n",
  },
  "globex-landing": {
    "package.json": JSON.stringify(
      { name: "globex-landing", scripts: { start: "vite preview" }, dependencies: { vite: "6.0.0" } },
      null,
      2,
    ),
  },
  "globex-docs": {
    "package.json": JSON.stringify(
      { name: "globex-docs", scripts: { start: "next start" }, dependencies: { next: "15.0.0" } },
      null,
      2,
    ),
  },
};

/** Writes the fixture projects under a fresh temp folder. Returns the folder and each project's path. */
export async function writeFixtures(
  extra: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  base: Readonly<Record<string, Readonly<Record<string, string>>>> = FIXTURE_FILES,
): Promise<{ root: string; projects: { id: string; path: string }[] }> {
  const root = await mkdtemp(join(tmpdir(), "majhi-map-"));
  const all: Record<string, Readonly<Record<string, string>>> = { ...base };
  for (const [id, files] of Object.entries(extra)) all[id] = { ...(all[id] ?? {}), ...files };
  const projects: { id: string; path: string }[] = [];
  for (const [id, files] of Object.entries(all)) {
    const path = join(root, id);
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(path, name)), { recursive: true });
      await writeFile(join(path, name), text);
    }
    projects.push({ id, path });
  }
  return { root, projects };
}
