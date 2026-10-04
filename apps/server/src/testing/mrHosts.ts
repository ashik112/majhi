import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Stand-ins for the MR hosts, so tests never reach a real one (SPEC 5.5). `gh` and `glab` are small
 * programs that keep their pull requests in a JSON file; a merge really moves the branch in the
 * bare repo the "host" holds. Bitbucket is a local HTTP server that does the same.
 */

export type FakeCi = "none" | "pending" | "passing" | "failing";

export interface FakeMr {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "OPEN" | "MERGED" | "CLOSED";
}

export interface FakeCall {
  bin: string;
  args: string[];
  stdin: string;
  /** The token variables the program was started with. */
  env: Record<string, string>;
}

export interface FakeHostState {
  /** `owner/repo` to the bare repository that stands for it on the host. */
  repos: Record<string, string>;
  prs: Record<string, FakeMr[]>;
  ci: Record<string, FakeCi>;
  /** `owner/repo` to a message: `merge` fails with it. */
  mergeFails: Record<string, string>;
  /** `owner/repo` to the token the program must be given. */
  requireToken: Record<string, string>;
  calls: FakeCall[];
}

const SCRIPT = String.raw`#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const STATE = __STATE__;
const KIND = __KIND__;
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
let stdin = "";
if (args.includes("-")) { try { stdin = fs.readFileSync(0, "utf8"); } catch {} }
const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));
const tokenVar = KIND === "gh" ? "GH_TOKEN" : "GITLAB_TOKEN";
state.calls.push({ bin: KIND, args, stdin, env: Object.fromEntries(["GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "GH_HOST", "GITLAB_HOST"].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) });
const fail = (msg) => { save(); process.stderr.write(msg + "\n"); process.exit(1); };
// The review reads (gh api, glab api) are concurrent GETs: the fake has no reviews, and must not write the shared state.
if (args[0] === "api") { process.stdout.write("HTTP/2.0 404 Not Found\r\n\r\n{}"); process.exit(1); }
const slug = flag("--repo");
const need = state.requireToken[slug];
if (need !== undefined && process.env[tokenVar] !== need) fail("authentication required for " + slug);
const list = (state.prs[slug] = state.prs[slug] || []);
const bare = state.repos[slug];
const sh = (a) => cp.execFileSync("git", ["--git-dir", bare, ...a], { encoding: "utf8" }).trim();
const find = (n) => list.find((p) => p.number === Number(n)) || fail("no such request " + n);
const rollup = () => ({ passing: [{ status: "COMPLETED", conclusion: "SUCCESS" }], failing: [{ status: "COMPLETED", conclusion: "FAILURE" }], pending: [{ status: "IN_PROGRESS", conclusion: "" }], none: [] })[state.ci[slug] || "none"];
const pipeline = () => ({ passing: "success", failing: "failed", pending: "running", none: null })[state.ci[slug] || "none"];
const mergeInBare = (pr) => {
  if (state.mergeFails[slug]) fail(state.mergeFails[slug]);
  const head = sh(["rev-parse", "refs/heads/" + pr.head]);
  try { sh(["merge-base", "--is-ancestor", "refs/heads/" + pr.base, head]); } catch { fail("cannot fast-forward " + pr.base); }
  sh(["update-ref", "refs/heads/" + pr.base, head]);
  pr.state = "MERGED";
};
const [a, b, n] = args;
if (KIND === "gh" && a === "pr") {
  if (b === "create") {
    const pr = { number: list.length + 1, head: flag("--head"), base: flag("--base"), title: flag("--title"), body: stdin, state: "OPEN" };
    list.push(pr); save();
    process.stdout.write("https://github.com/" + slug + "/pull/" + pr.number + "\n");
  } else if (b === "edit") { find(n).body = stdin; save(); }
  else if (b === "view") {
    const pr = find(n); save();
    process.stdout.write(JSON.stringify({ state: pr.state, url: "https://github.com/" + slug + "/pull/" + pr.number, statusCheckRollup: rollup() }));
  } else if (b === "merge") { mergeInBare(find(n)); save(); }
  else fail("unknown gh command");
} else if (KIND === "glab" && a === "mr") {
  if (b === "create") {
    const pr = { number: list.length + 1, head: flag("--source-branch"), base: flag("--target-branch"), title: flag("--title"), body: stdin, state: "OPEN" };
    list.push(pr); save();
    process.stdout.write("Creating merge request for " + pr.head + " into " + pr.base + "\n\nhttps://gitlab.com/" + slug + "/-/merge_requests/" + pr.number + "\n");
  } else if (b === "update") { find(n).body = stdin; save(); }
  else if (b === "view") {
    const pr = find(n); save();
    const p = pipeline();
    process.stdout.write(JSON.stringify({ state: { OPEN: "opened", MERGED: "merged", CLOSED: "closed" }[pr.state], web_url: "https://gitlab.com/" + slug + "/-/merge_requests/" + pr.number, head_pipeline: p ? { status: p } : null }));
  } else if (b === "merge") { mergeInBare(find(n)); save(); }
  else fail("unknown glab command");
} else fail("unknown command");
`;

export interface FakeHosts {
  /** The paths of the fake programs. */
  bins: { gh: string; glab: string };
  state(): Promise<FakeHostState>;
  update(change: (state: FakeHostState) => void): Promise<void>;
  /** Makes `owner/repo` on the fake host stand for a bare repository. */
  addRepo(slug: string, bare: string): Promise<void>;
}

/** Writes fake `gh` and `glab` programs into `dir`. */
export async function fakeHosts(dir: string): Promise<FakeHosts> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "hosts.json");
  const initial: FakeHostState = { repos: {}, prs: {}, ci: {}, mergeFails: {}, requireToken: {}, calls: [] };
  await writeFile(file, JSON.stringify(initial));
  const bins = { gh: join(dir, "gh"), glab: join(dir, "glab") };
  for (const [kind, path] of [
    ["gh", bins.gh],
    ["glab", bins.glab],
  ] as const) {
    const source = SCRIPT.replace("__STATE__", JSON.stringify(file)).replace(
      "__KIND__",
      JSON.stringify(kind),
    );
    await writeFile(path, source, { mode: 0o755 });
  }
  const read = async () => JSON.parse(await readFile(file, "utf8")) as FakeHostState;
  return {
    bins,
    state: read,
    async update(change) {
      const s = await read();
      change(s);
      await writeFile(file, JSON.stringify(s));
    },
    async addRepo(slug, bare) {
      const s = await read();
      s.repos[slug] = bare;
      await writeFile(file, JSON.stringify(s));
    },
  };
}

export interface FakeBitbucket {
  url: string;
  requests: { method: string; path: string; auth: string | undefined; body: unknown }[];
  prs: Map<number, { title: string; description: string; head: string; base: string; state: string }>;
  ci: FakeCi;
  repos: Record<string, string>;
  /** The Authorization header the server accepts. */
  accept: string;
  close(): Promise<void>;
}

/** A local Bitbucket Cloud: the few routes majhi uses. */
export async function fakeBitbucket(accept: string): Promise<FakeBitbucket> {
  const fake: FakeBitbucket = {
    url: "",
    requests: [],
    prs: new Map(),
    ci: "none",
    repos: {},
    accept,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", (d: Buffer) => {
      text += d.toString();
    });
    req.on("end", () => {
      void handle(fake, req.method ?? "GET", req.url ?? "/", req.headers.authorization, text).then(
        ({ status, body }) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

async function handle(
  fake: FakeBitbucket,
  method: string,
  path: string,
  auth: string | undefined,
  text: string,
) {
  const body: unknown = text === "" ? undefined : JSON.parse(text);
  fake.requests.push({ method, path, auth, body });
  if (auth !== fake.accept) return { status: 401, body: { error: { message: "Bad credentials" } } };
  const m = /^\/repositories\/([^/]+\/[^/]+)\/pullrequests(?:\/(\d+))?(?:\/(statuses|merge))?$/.exec(path);
  if (!m) return { status: 404, body: { error: { message: "Not found" } } };
  const slug = m[1] as string;
  const n = m[2] === undefined ? undefined : Number(m[2]);
  const link = (id: number) => ({
    id,
    links: { html: { href: `https://bitbucket.org/${slug}/pull-requests/${id}` } },
  });
  if (n === undefined && method === "POST") {
    const b = body as {
      title: string;
      description: string;
      source: { branch: { name: string } };
      destination: { branch: { name: string } };
    };
    const id = fake.prs.size + 1;
    fake.prs.set(id, {
      title: b.title,
      description: b.description,
      head: b.source.branch.name,
      base: b.destination.branch.name,
      state: "OPEN",
    });
    return { status: 201, body: link(id) };
  }
  const pr = n === undefined ? undefined : fake.prs.get(n);
  if (n === undefined || pr === undefined)
    return { status: 404, body: { error: { message: "No such pull request" } } };
  if (m[3] === "statuses") {
    const state = { passing: "SUCCESSFUL", failing: "FAILED", pending: "INPROGRESS", none: undefined }[
      fake.ci
    ];
    return { status: 200, body: { values: state === undefined ? [] : [{ state }] } };
  }
  if (m[3] === "merge" && method === "POST") {
    const bare = fake.repos[slug] as string;
    const git = (a: string[]) => run("git", ["--git-dir", bare, ...a]).then((r) => r.stdout.trim());
    const head = await git(["rev-parse", `refs/heads/${pr.head}`]);
    await git(["update-ref", `refs/heads/${pr.base}`, head]);
    pr.state = "MERGED";
    return { status: 200, body: { ...link(n), state: "MERGED" } };
  }
  if (method === "PUT") {
    const b = body as { title?: string; description?: string };
    if (b.title !== undefined) pr.title = b.title;
    if (b.description !== undefined) pr.description = b.description;
    return { status: 200, body: link(n) };
  }
  return { status: 200, body: { ...link(n), state: pr.state } };
}
