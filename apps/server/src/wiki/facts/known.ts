import type { WikiKnownRole } from "@majhi/shared";
import { wordsOf } from "../system/resolver.ts";

/**
 * What the fact scanners know by name. These are typed tables, not guesses over text: an image name, a
 * URL scheme, a dependency name or a host is looked up exactly. A name that is not here makes no fact.
 */

export interface Store {
  /** `redis`: part of the id of the store fact. */
  slug: string;
  label: string;
  kind: "database" | "queue" | "cache";
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
const SQLITE: Store = { slug: "sqlite", label: "SQLite", kind: "database" };

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

/** Client libraries: a project that depends on one uses that store. */
const NPM_STORES: Readonly<Record<string, Store>> = {
  pg: POSTGRES,
  postgres: POSTGRES,
  mysql2: MYSQL,
  mongodb: MONGO,
  mongoose: MONGO,
  redis: REDIS,
  ioredis: REDIS,
  bullmq: REDIS,
  bull: REDIS,
  amqplib: RABBIT,
  kafkajs: KAFKA,
  nats: NATS,
  "@elastic/elasticsearch": ELASTIC,
  "better-sqlite3": SQLITE,
  sqlite3: SQLITE,
  "@libsql/client": SQLITE,
  libsql: SQLITE,
};

const PYTHON_STORES: Readonly<Record<string, Store>> = {
  psycopg: POSTGRES,
  psycopg2: POSTGRES,
  "psycopg2-binary": POSTGRES,
  asyncpg: POSTGRES,
  pymysql: MYSQL,
  mysqlclient: MYSQL,
  pymongo: MONGO,
  motor: MONGO,
  redis: REDIS,
  "django-redis": REDIS,
  rq: REDIS,
  pika: RABBIT,
  "kafka-python": KAFKA,
  "confluent-kafka": KAFKA,
  aiosqlite: SQLITE,
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
const HACKER_NEWS: Outside = { slug: "hacker-news", label: "Hacker News" };
const TELEGRAM: Outside = { slug: "telegram", label: "Telegram" };
const EXA: Outside = { slug: "exa", label: "Exa" };
const FIRECRAWL: Outside = { slug: "firecrawl", label: "Firecrawl" };

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
  "news.ycombinator.com": HACKER_NEWS,
  "hacker-news.firebaseio.com": HACKER_NEWS,
  "api.telegram.org": TELEGRAM,
  "api.exa.ai": EXA,
  "api.firecrawl.dev": FIRECRAWL,
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

/** What a dependency says about the repo: its role, and the technology that gives it. */
export interface Tech {
  role: WikiKnownRole;
  tech: string;
}

/** Packages that run a user interface in a browser or on a phone. */
const NPM_FRONTEND: Readonly<Record<string, string>> = {
  next: "Next.js",
  nuxt: "Nuxt",
  "@sveltejs/kit": "SvelteKit",
  "@remix-run/react": "Remix",
  astro: "Astro",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  "solid-js": "Solid",
  "@angular/core": "Angular",
  "react-native": "React Native",
  expo: "Expo",
};

/** Server frameworks: a repo that depends on one answers requests. */
const NPM_BACKEND: Readonly<Record<string, string>> = {
  "@nestjs/core": "NestJS",
  fastify: "Fastify",
  express: "Express",
  hono: "Hono",
  koa: "Koa",
  "@trpc/server": "tRPC",
};

const PYTHON_BACKEND: Readonly<Record<string, string>> = {
  django: "Django",
  fastapi: "FastAPI",
  flask: "Flask",
  starlette: "Starlette",
  aiohttp: "aiohttp",
  tornado: "Tornado",
  sanic: "Sanic",
  litestar: "Litestar",
};

/** Libraries that run jobs outside the request. */
const NPM_WORKER: Readonly<Record<string, string>> = {
  bullmq: "BullMQ",
  bull: "Bull",
  "node-cron": "node-cron",
};

const PYTHON_WORKER: Readonly<Record<string, string>> = {
  celery: "Celery",
  rq: "RQ",
  dramatiq: "Dramatiq",
  huey: "Huey",
  arq: "arq",
  apscheduler: "APScheduler",
};

/** Sign-in and token libraries. No tool finds auth by itself, so the catalog names the common ones. */
const NPM_AUTH: Readonly<Record<string, string>> = {
  passport: "Passport",
  "next-auth": "NextAuth",
  "@auth/core": "Auth.js",
  "better-auth": "Better Auth",
  lucia: "Lucia",
  "@clerk/nextjs": "Clerk",
  "@clerk/clerk-react": "Clerk",
  jsonwebtoken: "JWT",
  jose: "JWT",
  bcrypt: "bcrypt",
  bcryptjs: "bcrypt",
};

const PYTHON_AUTH: Readonly<Record<string, string>> = {
  pyjwt: "JWT",
  "python-jose": "JWT",
  authlib: "Authlib",
  "django-allauth": "django-allauth",
  djangorestframework_simplejwt: "JWT",
  "djangorestframework-simplejwt": "JWT",
  "fastapi-users": "FastAPI Users",
  passlib: "Passlib",
  bcrypt: "bcrypt",
};

const STORE_ROLE: Readonly<Record<Store["kind"], WikiKnownRole>> = {
  database: "database",
  queue: "queue",
  cache: "cache",
};

/**
 * The roles one dependency shows, from the typed tables above. A dependency with no entry shows nothing.
 * Python names are normalized (`normalizePython`), npm names are as written in package.json.
 */
export function techsOfDep(dep: string, python: boolean): Tech[] {
  const out: Tech[] = [];
  const add = (role: WikiKnownRole, tech: string | undefined) => {
    if (tech !== undefined) out.push({ role, tech });
  };
  if (python) {
    add("backend", PYTHON_BACKEND[dep]);
    add("worker", PYTHON_WORKER[dep]);
    add("auth", PYTHON_AUTH[dep]);
  } else {
    add("frontend", NPM_FRONTEND[dep]);
    add("backend", NPM_BACKEND[dep]);
    add("worker", NPM_WORKER[dep]);
    add("auth", NPM_AUTH[dep]);
  }
  const store = python ? storeOfPython(dep) : storeOfNpm(dep);
  if (store !== undefined) add(STORE_ROLE[store.kind], store.label);
  const outside = python ? outsideOfPython(dep) : outsideOfNpm(dep);
  add("outside", outside?.label);
  return out;
}

/** The role of the store behind an image, a scheme or a driver. */
export const roleOfStore = (store: Store): WikiKnownRole => STORE_ROLE[store.kind];

/** The part of an image name after the last `/` and before the tag or digest. */
export function imageName(image: string): string {
  const afterSlash = image.slice(image.lastIndexOf("/") + 1);
  const at = afterSlash.indexOf("@");
  const noDigest = at < 0 ? afterSlash : afterSlash.slice(0, at);
  const colon = noDigest.indexOf(":");
  return (colon < 0 ? noDigest : noDigest.slice(0, colon)).toLowerCase();
}

/** Images of programs that sit in front of an app or route to it: they are infrastructure, not part of the app. */
const INFRA_IMAGES: ReadonlySet<string> = new Set(["traefik", "nginx", "caddy", "haproxy", "envoy", "kong"]);

/** The role an image alone shows: a datastore, or a proxy. */
export function roleOfImage(image: string): WikiKnownRole | undefined {
  const store = storeOfImage(image);
  if (store !== undefined) return roleOfStore(store);
  return INFRA_IMAGES.has(imageName(image)) ? "infra" : undefined;
}

export const storeOfImage = (image: string): Store | undefined => IMAGES[imageName(image)];
export const storeOfScheme = (scheme: string): Store | undefined => SCHEMES[scheme.toLowerCase()];
export const storeOfNpm = (dep: string): Store | undefined => NPM_STORES[dep];
export const storeOfPython = (dep: string): Store | undefined => PYTHON_STORES[dep];
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
