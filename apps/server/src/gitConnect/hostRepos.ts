import type { MrHost, RemoteOwner, RemoteRepo } from "@majhi/shared";
import { z } from "zod";
import { UserError } from "../errors.ts";
import { call, callWithToken, type Fetch, HostUnreachable, type HttpAnswer, TokenRefused } from "./http.ts";
import { bitbucketAuth } from "./oauth.ts";

/**
 * Repos and owners on GitHub, GitLab and Bitbucket, with the workspace's token, and making a new
 * repo there. Every answer is parsed with zod; an item that does not parse is skipped. Repo names
 * and descriptions are data: they are passed on as text and never read as instructions.
 */

/** A repo before majhi marks where it is on this computer. */
export type HostRepo = Omit<RemoteRepo, "here">;

export interface RepoPage {
  repos: HostRepo[];
  nextPage?: number;
}

/** GitHub: how many pages of 100 majhi reads to filter by name before it uses the search API. */
export const GITHUB_FILTER_PAGES = 5;

const GITHUB_API = "https://api.github.com";
const BITBUCKET_API = "https://api.bitbucket.org/2.0";
/** At most this many Bitbucket workspaces are listed per page of repos. */
const BITBUCKET_MAX_WORKSPACES = 20;

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
}

const GitHubRepoSchema = z.object({
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  description: z.string().nullable().optional(),
  private: z.boolean(),
  default_branch: z.string().optional(),
  pushed_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  size: z.number().optional(),
  html_url: z.string(),
  clone_url: z.string(),
  ssh_url: z.string().optional(),
});

const GitLabProjectSchema = z.object({
  id: z.number(),
  path_with_namespace: z.string(),
  path: z.string(),
  namespace: z.object({ full_path: z.string() }),
  description: z.string().nullable().optional(),
  visibility: z.string().optional(),
  default_branch: z.string().nullable().optional(),
  last_activity_at: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  empty_repo: z.boolean().optional(),
  web_url: z.string(),
  http_url_to_repo: z.string(),
  ssh_url_to_repo: z.string().optional(),
});

const BitbucketRepoSchema = z.object({
  full_name: z.string(),
  slug: z.string(),
  workspace: z.object({ slug: z.string() }).optional(),
  description: z.string().nullable().optional(),
  is_private: z.boolean(),
  mainbranch: z.object({ name: z.string() }).nullable().optional(),
  updated_on: z.string().nullable().optional(),
  links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
});

function isoOrUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function items<T>(schema: z.ZodType<T>, list: unknown): T[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function fromGitHub(r: z.infer<typeof GitHubRepoSchema>): HostRepo {
  const updatedAt = isoOrUndefined(r.pushed_at ?? r.updated_at);
  return {
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    ...(r.description ? { description: r.description } : {}),
    private: r.private,
    ...(r.default_branch !== undefined && r.size !== 0 ? { defaultBranch: r.default_branch } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    archived: r.archived === true,
    webUrl: r.html_url,
    httpsUrl: `https://github.com/${r.full_name}.git`,
    ...(r.ssh_url === undefined ? {} : { sshUrl: r.ssh_url }),
  };
}

function fromGitLab(host: string, p: z.infer<typeof GitLabProjectSchema>): HostRepo {
  const updatedAt = isoOrUndefined(p.last_activity_at);
  return {
    fullName: p.path_with_namespace,
    name: p.path,
    owner: p.namespace.full_path,
    ...(p.description ? { description: p.description } : {}),
    private: p.visibility !== "public",
    ...(p.default_branch && p.empty_repo !== true ? { defaultBranch: p.default_branch } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    archived: p.archived === true,
    webUrl: p.web_url,
    httpsUrl: `https://${host}/${p.path_with_namespace}.git`,
    ...(p.ssh_url_to_repo === undefined ? {} : { sshUrl: p.ssh_url_to_repo }),
  };
}

function fromBitbucket(r: z.infer<typeof BitbucketRepoSchema>): HostRepo {
  const updatedAt = isoOrUndefined(r.updated_on);
  const owner = r.workspace?.slug ?? r.full_name.split("/")[0] ?? "";
  return {
    fullName: r.full_name,
    name: r.slug,
    owner,
    ...(r.description ? { description: r.description } : {}),
    private: r.is_private,
    ...(r.mainbranch?.name === undefined ? {} : { defaultBranch: r.mainbranch.name }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    archived: false,
    webUrl: r.links?.html?.href ?? `https://bitbucket.org/${r.full_name}`,
    httpsUrl: `https://bitbucket.org/${r.full_name}.git`,
    sshUrl: `git@bitbucket.org:${r.full_name}.git`,
  };
}

/** The page number of `rel="next"` in a GitHub `Link` header. */
export function nextFromLink(link: string | null): number | undefined {
  if (link === null) return undefined;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (url === undefined) continue;
    try {
      const page = Number(new URL(url).searchParams.get("page"));
      return Number.isInteger(page) && page > 1 ? page : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function matches(repo: HostRepo, query: string): boolean {
  const q = query.toLowerCase();
  return repo.fullName.toLowerCase().includes(q);
}

export interface ListInput {
  host: string;
  account: string | undefined;
  query?: string | undefined;
  page: number;
  perPage: number;
}

/** One page of the repos the token sees. Throws `TokenRefused` or `HostUnreachable`. */
export async function listRepos(
  fetchFn: Fetch,
  kind: MrHost,
  token: string,
  input: ListInput,
): Promise<RepoPage> {
  if (kind === "github") return githubRepos(fetchFn, token, input);
  if (kind === "gitlab") return gitlabRepos(fetchFn, token, input);
  return bitbucketRepos(fetchFn, token, input);
}

async function githubPage(
  fetchFn: Fetch,
  token: string,
  page: number,
  perPage: number,
): Promise<{ repos: HostRepo[]; next?: number }> {
  const url = new URL(`${GITHUB_API}/user/repos`);
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  const answer = await callWithToken(fetchFn, url.toString(), { headers: githubHeaders(token) });
  const next = nextFromLink(answer.headers.get("link"));
  return {
    repos: items(GitHubRepoSchema, answer.body).map(fromGitHub),
    ...(next === undefined ? {} : { next }),
  };
}

/**
 * GitHub. No query: one page of `/user/repos`. A query: majhi reads up to five pages of 100 and
 * filters by name on the server; when the account sees more repos than that, it asks the search
 * API instead, limited to the account and its organizations (see DECISIONS).
 */
async function githubRepos(fetchFn: Fetch, token: string, input: ListInput): Promise<RepoPage> {
  const query = input.query?.trim() ?? "";
  if (query === "") {
    const page = await githubPage(fetchFn, token, input.page, input.perPage);
    return { repos: page.repos, ...(page.next === undefined ? {} : { nextPage: page.next }) };
  }
  const all: HostRepo[] = [];
  let more = false;
  for (let page = 1; page <= GITHUB_FILTER_PAGES; page++) {
    const got = await githubPage(fetchFn, token, page, 100);
    all.push(...got.repos);
    more = got.next !== undefined;
    if (!more) break;
  }
  if (!more)
    return slice(
      all.filter((r) => matches(r, query)),
      input.page,
      input.perPage,
    );
  return githubSearch(fetchFn, token, input, query);
}

async function githubSearch(
  fetchFn: Fetch,
  token: string,
  input: ListInput,
  query: string,
): Promise<RepoPage> {
  const orgsAnswer = await callWithToken(fetchFn, `${GITHUB_API}/user/orgs?per_page=100`, {
    headers: githubHeaders(token),
  });
  const orgs = items(z.object({ login: z.string() }), orgsAnswer.body).map((o) => o.login);
  const words = query.replace(/[^A-Za-z0-9_.-]+/g, " ").trim();
  const scope = [input.account, ...orgs]
    .filter((x): x is string => x !== undefined)
    .map((o, i) => `${i === 0 ? "user" : "org"}:${o}`);
  const url = new URL(`${GITHUB_API}/search/repositories`);
  url.searchParams.set("q", [words, "in:name", "fork:true", ...scope].join(" "));
  url.searchParams.set("sort", "updated");
  url.searchParams.set("per_page", String(input.perPage));
  url.searchParams.set("page", String(input.page));
  const answer = await callWithToken(fetchFn, url.toString(), { headers: githubHeaders(token) });
  const body = z.object({ total_count: z.number(), items: z.array(z.unknown()) }).safeParse(answer.body);
  if (!body.success) throw new HostUnreachable("GitHub's search answered something majhi does not know.");
  const repos = items(GitHubRepoSchema, body.data.items).map(fromGitHub);
  const shown = input.page * input.perPage;
  return { repos, ...(shown < Math.min(body.data.total_count, 1000) ? { nextPage: input.page + 1 } : {}) };
}

function slice(all: HostRepo[], page: number, perPage: number): RepoPage {
  const start = (page - 1) * perPage;
  const repos = all.slice(start, start + perPage);
  return { repos, ...(start + perPage < all.length ? { nextPage: page + 1 } : {}) };
}

async function gitlabRepos(fetchFn: Fetch, token: string, input: ListInput): Promise<RepoPage> {
  const url = new URL(`https://${input.host}/api/v4/projects`);
  url.searchParams.set("membership", "true");
  url.searchParams.set("order_by", "last_activity_at");
  url.searchParams.set("per_page", String(input.perPage));
  url.searchParams.set("page", String(input.page));
  if (input.query?.trim()) url.searchParams.set("search", input.query.trim());
  const answer = await callWithToken(fetchFn, url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  const next = Number(answer.headers.get("x-next-page") ?? "");
  return {
    repos: items(GitLabProjectSchema, answer.body).map((p) => fromGitLab(input.host, p)),
    ...(Number.isInteger(next) && next > 1 ? { nextPage: next } : {}),
  };
}

async function bitbucketWorkspaces(
  fetchFn: Fetch,
  token: string,
): Promise<{ slug: string; admin: boolean }[]> {
  const answer = await callWithToken(fetchFn, `${BITBUCKET_API}/user/workspaces?pagelen=100`, {
    headers: { authorization: bitbucketAuth(token) },
  });
  const values = z.object({ values: z.array(z.unknown()) }).safeParse(answer.body);
  if (!values.success) return [];
  return items(
    z.object({ administrator: z.boolean().optional(), workspace: z.object({ slug: z.string() }) }),
    values.data.values,
  ).map((w) => ({ slug: w.workspace.slug, admin: w.administrator === true }));
}

/**
 * Bitbucket lists repos per workspace (`/2.0/repositories/{workspace}`), so one page here is that
 * page of every workspace the account is in, merged and sorted by last update.
 */
async function bitbucketRepos(fetchFn: Fetch, token: string, input: ListInput): Promise<RepoPage> {
  const workspaces = (await bitbucketWorkspaces(fetchFn, token)).slice(0, BITBUCKET_MAX_WORKSPACES);
  const all: HostRepo[] = [];
  let more = false;
  for (const ws of workspaces) {
    const url = new URL(`${BITBUCKET_API}/repositories/${encodeURIComponent(ws.slug)}`);
    url.searchParams.set("role", "member");
    url.searchParams.set("sort", "-updated_on");
    url.searchParams.set("pagelen", String(input.perPage));
    url.searchParams.set("page", String(input.page));
    const q = input.query?.trim().replace(/["\\]/g, "");
    if (q) url.searchParams.set("q", `name ~ "${q}"`);
    const answer = await callWithToken(fetchFn, url.toString(), {
      headers: { authorization: bitbucketAuth(token) },
    });
    const page = z
      .object({ values: z.array(z.unknown()), next: z.string().optional() })
      .safeParse(answer.body);
    if (!page.success) continue;
    all.push(...items(BitbucketRepoSchema, page.data.values).map(fromBitbucket));
    if (page.data.next !== undefined) more = true;
  }
  all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return { repos: all, ...(more ? { nextPage: input.page + 1 } : {}) };
}

/** Where the account can make a repo. Throws `TokenRefused` or `HostUnreachable`. */
export async function listOwners(
  fetchFn: Fetch,
  kind: MrHost,
  host: string,
  token: string,
  account: string,
): Promise<RemoteOwner[]> {
  if (kind === "github") {
    const answer = await callWithToken(fetchFn, `${GITHUB_API}/user/orgs?per_page=100`, {
      headers: githubHeaders(token),
    });
    return [
      { name: account, kind: "user" },
      ...items(z.object({ login: z.string() }), answer.body).map((o) => ({
        name: o.login,
        kind: "organization" as const,
      })),
    ];
  }
  if (kind === "gitlab") {
    const answer = await callWithToken(fetchFn, `https://${host}/api/v4/namespaces?per_page=100`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return items(z.object({ full_path: z.string(), kind: z.string() }), answer.body).map((n) => ({
      name: n.full_path,
      kind: n.kind === "user" ? ("user" as const) : ("group" as const),
    }));
  }
  return (await bitbucketWorkspaces(fetchFn, token)).map((w) => ({
    name: w.slug,
    kind: "workspace" as const,
  }));
}

export interface NewRepo {
  owner: string;
  name: string;
  private: boolean;
  description?: string | undefined;
}

export interface CreatedRepo {
  fullName: string;
  webUrl: string;
  httpsUrl: string;
  sshUrl: string;
}

/** The host's own short reason for refusing, as data, cut to one line. */
function hostMessage(answer: HttpAnswer): string | undefined {
  const body = answer.body as { message?: unknown; error?: { message?: unknown } } | undefined;
  const raw = body?.message ?? body?.error?.message;
  const text =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.join(" ")
        : typeof raw === "object" && raw !== null
          ? JSON.stringify(raw)
          : undefined;
  return text?.replace(/\s+/g, " ").slice(0, 200);
}

async function created(
  fetchFn: Fetch,
  url: string,
  req: Parameters<typeof call>[2],
  what: string,
): Promise<HttpAnswer> {
  const answer = await call(fetchFn, url, req);
  if (answer.status === 401) throw new TokenRefused("The host refused the workspace's token.");
  if (answer.status < 200 || answer.status >= 300) {
    const why = hostMessage(answer);
    throw new UserError(`${what} was refused${why === undefined ? "" : `: ${why}`}.`, 409);
  }
  return answer;
}

/** Makes the repo on the host. Throws `TokenRefused`, `HostUnreachable`, or a `UserError` with the host's reason. */
export async function createRepo(
  fetchFn: Fetch,
  kind: MrHost,
  host: string,
  token: string,
  account: string,
  repo: NewRepo,
): Promise<CreatedRepo> {
  if (kind === "github") {
    const url =
      repo.owner.toLowerCase() === account.toLowerCase()
        ? `${GITHUB_API}/user/repos`
        : `${GITHUB_API}/orgs/${encodeURIComponent(repo.owner)}/repos`;
    const answer = await created(
      fetchFn,
      url,
      {
        headers: githubHeaders(token),
        json: {
          name: repo.name,
          private: repo.private,
          auto_init: false,
          ...(repo.description ? { description: repo.description } : {}),
        },
      },
      `Creating ${repo.owner}/${repo.name} on GitHub`,
    );
    const r = GitHubRepoSchema.safeParse(answer.body);
    if (!r.success) throw new HostUnreachable("GitHub made the repo but did not say where.");
    return {
      fullName: r.data.full_name,
      webUrl: r.data.html_url,
      httpsUrl: `https://github.com/${r.data.full_name}.git`,
      sshUrl: `git@github.com:${r.data.full_name}.git`,
    };
  }
  if (kind === "gitlab") {
    const search = new URL(`https://${host}/api/v4/namespaces`);
    search.searchParams.set("search", repo.owner);
    search.searchParams.set("per_page", "100");
    const found = await callWithToken(fetchFn, search.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    const ns = items(z.object({ id: z.number(), full_path: z.string() }), found.body).find(
      (n) => n.full_path.toLowerCase() === repo.owner.toLowerCase(),
    );
    if (ns === undefined)
      throw new UserError(`${repo.owner} is not a group or user this account can use on ${host}.`, 409);
    const answer = await created(
      fetchFn,
      `https://${host}/api/v4/projects`,
      {
        headers: { authorization: `Bearer ${token}` },
        json: {
          name: repo.name,
          path: repo.name,
          namespace_id: ns.id,
          visibility: repo.private ? "private" : "public",
          initialize_with_readme: false,
          ...(repo.description ? { description: repo.description } : {}),
        },
      },
      `Creating ${repo.owner}/${repo.name} on ${host}`,
    );
    const p = GitLabProjectSchema.safeParse(answer.body);
    if (!p.success) throw new HostUnreachable(`${host} made the project but did not say where.`);
    return {
      fullName: p.data.path_with_namespace,
      webUrl: p.data.web_url,
      httpsUrl: `https://${host}/${p.data.path_with_namespace}.git`,
      sshUrl: `git@${host}:${p.data.path_with_namespace}.git`,
    };
  }
  const slug = repo.name.toLowerCase();
  const answer = await created(
    fetchFn,
    `${BITBUCKET_API}/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(slug)}`,
    {
      headers: { authorization: bitbucketAuth(token) },
      json: {
        scm: "git",
        is_private: repo.private,
        ...(repo.description ? { description: repo.description } : {}),
      },
    },
    `Creating ${repo.owner}/${slug} on Bitbucket`,
  );
  const r = BitbucketRepoSchema.safeParse(answer.body);
  const fullName = r.success ? r.data.full_name : `${repo.owner}/${slug}`;
  return {
    fullName,
    webUrl: r.success
      ? (r.data.links?.html?.href ?? `https://bitbucket.org/${fullName}`)
      : `https://bitbucket.org/${fullName}`,
    httpsUrl: `https://bitbucket.org/${fullName}.git`,
    sshUrl: `git@bitbucket.org:${fullName}.git`,
  };
}
