import type { MapNodeKind, MapRole } from "@majhi/shared";
import { wordsOf } from "./resolver.ts";

/**
 * What the config pass knows by name. These are typed tables, not guesses over text: an image name, a
 * URL scheme, a dependency name or a host is looked up exactly. A name that is not here makes no node.
 */

export interface Store {
  /** `redis`: the node is `store:redis`. */
  slug: string;
  label: string;
  kind: Extract<MapNodeKind, "database" | "queue" | "cache">;
}

const POSTGRES: Store = { slug: "postgres", label: "Postgres", kind: "database" };
const MYSQL: Store = { slug: "mysql", label: "MySQL", kind: "database" };
const MONGO: Store = { slug: "mongodb", label: "MongoDB", kind: "database" };
const REDIS: Store = { slug: "redis", label: "Redis", kind: "cache" };
const RABBIT: Store = { slug: "rabbitmq", label: "RabbitMQ", kind: "queue" };
const KAFKA: Store = { slug: "kafka", label: "Kafka", kind: "queue" };
const NATS: Store = { slug: "nats", label: "NATS", kind: "queue" };
const MEMCACHED: Store = { slug: "memcached", label: "Memcached", kind: "cache" };
const ELASTIC: Store = { slug: "elasticsearch", label: "Elasticsearch", kind: "database" };
const CLICKHOUSE: Store = { slug: "clickhouse", label: "ClickHouse", kind: "database" };

/** The last part of an image name (`bitnami/postgresql:16` is `postgresql`). */
const IMAGES: Readonly<Record<string, Store>> = {
  postgres: POSTGRES,
  postgresql: POSTGRES,
  postgis: POSTGRES,
  timescaledb: POSTGRES,
  mysql: MYSQL,
  mariadb: MYSQL,
  mongo: MONGO,
  mongodb: MONGO,
  redis: REDIS,
  valkey: REDIS,
  "redis-stack": REDIS,
  rabbitmq: RABBIT,
  kafka: KAFKA,
  "cp-kafka": KAFKA,
  redpanda: KAFKA,
  nats: NATS,
  memcached: MEMCACHED,
  elasticsearch: ELASTIC,
  opensearch: ELASTIC,
  clickhouse: CLICKHOUSE,
  "clickhouse-server": CLICKHOUSE,
};

/** The scheme of a connection URL. */
const SCHEMES: Readonly<Record<string, Store>> = {
  postgres: POSTGRES,
  postgresql: POSTGRES,
  mysql: MYSQL,
  mysql2: MYSQL,
  mariadb: MYSQL,
  mongodb: MONGO,
  "mongodb+srv": MONGO,
  redis: REDIS,
  rediss: REDIS,
  amqp: RABBIT,
  amqps: RABBIT,
  kafka: KAFKA,
  nats: NATS,
  memcached: MEMCACHED,
  clickhouse: CLICKHOUSE,
};

/** Client libraries: a project that depends on one uses that store. `via` is the edge it draws. */
const NPM_STORES: Readonly<Record<string, { store: Store; via: "data" | "queue" }>> = {
  pg: { store: POSTGRES, via: "data" },
  postgres: { store: POSTGRES, via: "data" },
  mysql2: { store: MYSQL, via: "data" },
  mongodb: { store: MONGO, via: "data" },
  mongoose: { store: MONGO, via: "data" },
  redis: { store: REDIS, via: "data" },
  ioredis: { store: REDIS, via: "data" },
  bullmq: { store: REDIS, via: "queue" },
  bull: { store: REDIS, via: "queue" },
  amqplib: { store: RABBIT, via: "queue" },
  kafkajs: { store: KAFKA, via: "queue" },
  nats: { store: NATS, via: "queue" },
  "@elastic/elasticsearch": { store: ELASTIC, via: "data" },
};

const PYTHON_STORES: Readonly<Record<string, { store: Store; via: "data" | "queue" }>> = {
  psycopg: { store: POSTGRES, via: "data" },
  psycopg2: { store: POSTGRES, via: "data" },
  "psycopg2-binary": { store: POSTGRES, via: "data" },
  asyncpg: { store: POSTGRES, via: "data" },
  pymysql: { store: MYSQL, via: "data" },
  mysqlclient: { store: MYSQL, via: "data" },
  pymongo: { store: MONGO, via: "data" },
  motor: { store: MONGO, via: "data" },
  redis: { store: REDIS, via: "data" },
  "django-redis": { store: REDIS, via: "data" },
  rq: { store: REDIS, via: "queue" },
  pika: { store: RABBIT, via: "queue" },
  "kafka-python": { store: KAFKA, via: "queue" },
  "confluent-kafka": { store: KAFKA, via: "queue" },
};

export interface Outside {
  slug: string;
  label: string;
}

const STRIPE: Outside = { slug: "stripe", label: "Stripe" };
const OPENAI: Outside = { slug: "openai", label: "OpenAI" };
const ANTHROPIC: Outside = { slug: "anthropic", label: "Anthropic" };
const REPLICATE: Outside = { slug: "replicate", label: "Replicate" };
const SENTRY: Outside = { slug: "sentry", label: "Sentry" };
const TWILIO: Outside = { slug: "twilio", label: "Twilio" };
const SENDGRID: Outside = { slug: "sendgrid", label: "SendGrid" };
const SLACK: Outside = { slug: "slack", label: "Slack" };
const RESEND: Outside = { slug: "resend", label: "Resend" };
const GITHUB: Outside = { slug: "github", label: "GitHub" };

const NPM_OUTSIDE: Readonly<Record<string, Outside>> = {
  stripe: STRIPE,
  "@stripe/stripe-js": STRIPE,
  openai: OPENAI,
  "@anthropic-ai/sdk": ANTHROPIC,
  replicate: REPLICATE,
  "@sentry/node": SENTRY,
  "@sentry/nextjs": SENTRY,
  twilio: TWILIO,
  "@sendgrid/mail": SENDGRID,
  "@slack/web-api": SLACK,
  "@slack/bolt": SLACK,
  resend: RESEND,
  "@octokit/rest": GITHUB,
};

const PYTHON_OUTSIDE: Readonly<Record<string, Outside>> = {
  stripe: STRIPE,
  openai: OPENAI,
  anthropic: ANTHROPIC,
  replicate: REPLICATE,
  "sentry-sdk": SENTRY,
  twilio: TWILIO,
  sendgrid: SENDGRID,
  "slack-sdk": SLACK,
  resend: RESEND,
};

/** The host of an API URL. A subdomain counts (`ingest.sentry.io`). */
const HOSTS: Readonly<Record<string, Outside>> = {
  "api.stripe.com": STRIPE,
  "api.openai.com": OPENAI,
  "api.anthropic.com": ANTHROPIC,
  "api.replicate.com": REPLICATE,
  "sentry.io": SENTRY,
  "api.twilio.com": TWILIO,
  "api.sendgrid.com": SENDGRID,
  "hooks.slack.com": SLACK,
  "slack.com": SLACK,
  "api.resend.com": RESEND,
  "api.github.com": GITHUB,
};

/**
 * Words of a variable name that say its value is not a call: a list of allowed origins, a CORS or CSRF
 * setting, a redirect or callback address, the project's own public address. A value under such a name is
 * never an endpoint. (A typed table of roles; the name is split into words, never matched as text.)
 */
const NOT_A_CALL_WORDS: ReadonlySet<string> = new Set([
  "origin",
  "origins",
  "cors",
  "csrf",
  "allowed",
  "allow",
  "allowlist",
  "whitelist",
  "trusted",
  "redirect",
  "redirects",
  "callback",
  "callbacks",
  "frontend",
  "site",
  "domain",
  "domains",
  "canonical",
  "sitemap",
]);

/** Whether a variable's role is "who may call me" or "my own address", not "whom I call". */
export function keyIsNotACall(key: string): boolean {
  return wordsOf(key).some((w) => NOT_A_CALL_WORDS.has(w));
}

/** Packages that run a user interface in a browser or on a phone. */
const APP_DEPS: ReadonlySet<string> = new Set([
  "next",
  "nuxt",
  "@sveltejs/kit",
  "vite",
  "react",
  "vue",
  "svelte",
  "@angular/core",
  "react-native",
  "expo",
  "flutter",
]);
const SERVICE_DEPS: ReadonlySet<string> = new Set([
  "django",
  "fastapi",
  "flask",
  "express",
  "@nestjs/core",
  "fastify",
  "koa",
  "hono",
  "aiohttp",
  "starlette",
  "uvicorn",
  "gunicorn",
]);
const WORKER_DEPS: ReadonlySet<string> = new Set([
  "celery",
  "rq",
  "bullmq",
  "bull",
  "dramatiq",
  "huey",
  "arq",
  "kafkajs",
  "pika",
]);
/** Frameworks that serve pages: they make an app even when a server library sits beside them. */
const PAGE_FRAMEWORKS: ReadonlySet<string> = new Set([
  "next",
  "nuxt",
  "@sveltejs/kit",
  "react-native",
  "expo",
]);

/**
 * What a project is, from its dependencies and its script names: a page framework is an app, else a server
 * framework is a service, else a job library or a `worker` script is a worker, else a UI library is an app.
 */
export function roleOfDeps(deps: ReadonlySet<string>, scripts: readonly string[]): MapRole {
  const has = (set: ReadonlySet<string>) => [...deps].some((d) => set.has(d));
  if ([...deps].some((d) => PAGE_FRAMEWORKS.has(d))) return "app";
  if (has(SERVICE_DEPS)) return "service";
  if (has(WORKER_DEPS) || scripts.some((s) => wordsOf(s).includes("worker"))) return "worker";
  if (has(APP_DEPS)) return "app";
  return "service";
}

const FRAMEWORKS: readonly (readonly [string, string])[] = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@sveltejs/kit", "SvelteKit"],
  ["@nestjs/core", "NestJS"],
  ["fastify", "Fastify"],
  ["express", "Express"],
  ["hono", "Hono"],
  ["koa", "Koa"],
  ["vue", "Vue"],
  ["react", "React"],
  ["svelte", "Svelte"],
];

const PYTHON_FRAMEWORKS: readonly (readonly [string, string])[] = [
  ["django", "Django"],
  ["fastapi", "FastAPI"],
  ["flask", "Flask"],
  ["celery", "Celery"],
];

/** The first listed framework the dependency names contain. */
export function frameworkOf(deps: ReadonlySet<string>, python: boolean): string | undefined {
  for (const [dep, label] of python ? PYTHON_FRAMEWORKS : FRAMEWORKS) if (deps.has(dep)) return label;
  return undefined;
}

/** The part of an image name after the last `/` and before the tag or digest. */
export function imageName(image: string): string {
  const afterSlash = image.slice(image.lastIndexOf("/") + 1);
  const at = afterSlash.indexOf("@");
  const noDigest = at < 0 ? afterSlash : afterSlash.slice(0, at);
  const colon = noDigest.indexOf(":");
  return (colon < 0 ? noDigest : noDigest.slice(0, colon)).toLowerCase();
}

export const storeOfImage = (image: string): Store | undefined => IMAGES[imageName(image)];
export const storeOfScheme = (scheme: string): Store | undefined => SCHEMES[scheme.toLowerCase()];
export const storeOfNpm = (dep: string) => NPM_STORES[dep];
export const storeOfPython = (dep: string) => PYTHON_STORES[dep];
export const outsideOfNpm = (dep: string): Outside | undefined => NPM_OUTSIDE[dep];
export const outsideOfPython = (dep: string): Outside | undefined => PYTHON_OUTSIDE[dep];

/** The service a host belongs to: the host itself or a parent domain in the table. */
export function outsideOfHost(host: string): Outside | undefined {
  const parts = host.toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const hit = HOSTS[parts.slice(i).join(".")];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const HTTP_CLIENTS: ReadonlySet<string> = new Set([
  "axios",
  "node-fetch",
  "got",
  "ky",
  "undici",
  "superagent",
  "requests",
  "httpx",
  "aiohttp",
  "urllib3",
]);

/** Whether a module is a client for another service: a datastore driver, an SDK or an HTTP client. */
export function isClientModule(name: string, python: boolean): boolean {
  if (HTTP_CLIENTS.has(name)) return true;
  return python
    ? storeOfPython(name) !== undefined || outsideOfPython(name) !== undefined
    : storeOfNpm(name) !== undefined || outsideOfNpm(name) !== undefined;
}
