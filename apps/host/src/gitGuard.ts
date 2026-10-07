/**
 * What keeps a repo from running commands in the helper's git, as majhi's own git does on the
 * server (apps/server/src/git/git.ts). The helper pushes from the project's checkout, whose
 * `.git/config` and hooks an agent outside a container can edit, and `ls-remote` reads the config
 * of any repo it starts in.
 * - Every command: no hooks, no fsmonitor, no `ext::` remotes (`GUARD_CONFIG`). `GIT_PROXY_COMMAND`
 *   set empty wins over every `core.gitProxy`, and `GIT_SSH_COMMAND` over `core.sshCommand`
 *   (`GUARD_ENV`).
 * - `ls-remote` names git's own upload-pack: git keeps the first `remote.<name>.uploadpack` it reads,
 *   so only the command's option beats the repo's. `clone` reads no repo's config.
 * - A push: `pushGuard`.
 * - Commands that read the work tree (`status`, `checkout`, `worktree add`): the filter drivers the
 *   repo's own config names are off (`filtersOff`).
 */
import type { RunFn } from "./ssh.ts";

/** `-c` options for every git command the helper runs. */
export const GUARD_CONFIG: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.ext.allow=never",
];

/** Environment for every git command the helper runs. */
export const GUARD_ENV: Readonly<Record<string, string>> = {
  GIT_PROXY_COMMAND: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

/** The option that makes `ls-remote` run git's own upload-pack. */
export const UPLOAD_PACK = "--upload-pack=git-upload-pack";

/** Every key `pushGuard` reads, as git's own regexp. */
const PUSH_KEYS =
  "^(credential\\.(.+\\.)?helper|core\\.(askpass|alternaterefscommand)|url\\..+\\.(insteadof|pushinsteadof))$";

/** `credential.helper` and `credential.<url>.helper`: one list, in config order. */
const HELPER = /^credential\.(.+\.)?helper$/;
const REWRITE = /^url\..+\.(insteadof|pushinsteadof)$/;

/** `git config` arguments that list every filter command, read without running anything. */
export const LIST_FILTERS: readonly string[] = [
  "config",
  "-z",
  "--show-scope",
  "--get-regexp",
  "^filter\\..+\\.(clean|smudge|process)$",
];

interface ConfigEntry {
  scope: string;
  key: string;
  value: string | undefined;
}

/** What `git config -z --show-scope --get-regexp` printed, entry by entry. */
function parseConfig(listed: string): ConfigEntry[] {
  const items = listed.split("\0");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    const [scope = "", item = ""] = [items[i], items[i + 1]];
    const at = item.indexOf("\n");
    entries.push(
      at === -1
        ? { scope, key: item, value: undefined }
        : { scope, key: item.slice(0, at), value: item.slice(at + 1) },
    );
  }
  return entries;
}

/** The repo's own config: its `.git/config`, its worktree config and what they include. */
const fromRepo = (e: ConfigEntry) => e.scope === "local" || e.scope === "worktree";

/**
 * Settings that turn off every filter driver the repo's own config names, from what `LIST_FILTERS`
 * printed, as the server does (apps/server/src/git/git.ts `repoCommands`): a filter then converts
 * nothing and is not required. The owner's global and system drivers (git-lfs, say) stay on.
 */
export function filtersOff(listed: string): [string, string][] {
  const off = new Map<string, string>();
  for (const { key } of parseConfig(listed).filter(fromRepo)) {
    const driver = key.slice(0, key.lastIndexOf("."));
    for (const name of ["clean", "smudge", "process"]) off.set(`${driver}.${name}`, "");
    off.set(`${driver}.required`, "false");
  }
  return [...off];
}

/**
 * Adds settings in the command-line scope, after any already there, so they win over the repo's.
 * Through the environment, not `-c`, which cuts a key at its first `=`: a driver's name may hold one.
 */
export function withConfig<E extends Record<string, string | undefined>>(
  env: E,
  settings: readonly (readonly [string, string])[],
): E {
  if (settings.length === 0) return env;
  const had = Number(env.GIT_CONFIG_COUNT ?? 0);
  const start = Number.isInteger(had) && had > 0 ? had : 0;
  const out: Record<string, string | undefined> = {
    ...env,
    GIT_CONFIG_COUNT: String(start + settings.length),
  };
  settings.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return out as E;
}

/**
 * The address a push goes to when the checkout's config has rewrites (`values` of its `insteadOf` and
 * `pushInsteadOf`). None that matches: the address as it is. Matches that are only the beginning of the
 * address are overridden by the address's own rewrite, which is longer. One that equals the address
 * ties with it, and the repo's comes first, so the address gets a closing slash, which every git host
 * takes and no value the repo planted for the plain address matches whole. Undefined when a value
 * equals that one too: then nothing is pushed.
 */
export function pushUrlFor(
  url: string,
  values: readonly string[],
): { url: string; override: boolean } | undefined {
  const hits = values.filter((v) => url.startsWith(v));
  if (hits.length === 0) return { url, override: false };
  if (!hits.includes(url)) return { url, override: true };
  const slashed = `${url}/`;
  return values.includes(slashed) ? undefined : { url: slashed, override: true };
}

export interface PushGuard {
  /** The address to push to: the one asked for, or it with a closing slash when a rewrite of the repo's equals it. */
  url: string;
  /** Options that go right after `push`. */
  options: string[];
  /** Environment to add to the push's: settings in `GIT_CONFIG_*`, and https only. */
  env: Record<string, string>;
}

/**
 * What a push from the checkout at `path` to `url` runs with, on top of `GUARD_CONFIG` and
 * `GUARD_ENV`, read with `git config`, which runs nothing:
 * - https only (`GIT_ALLOW_PROTOCOL`, which beats every `protocol.*.allow`), git's own receive-pack
 *   and no push signing, so no `gpg.program` runs.
 * - `core.askPass` and `core.alternateRefsCommand` from the repo get the owner's value, else none.
 * - With the owner's login (`ownLogin`), a credential helper the repo adds is dropped by emptying
 *   the list and adding the owner's back in order, so osxkeychain still answers. With a workspace
 *   token, gitAuth.ts empties the list already.
 * - A `url.<base>.insteadOf` or `pushInsteadOf` of the repo's that rewrites `url` is refused: git
 *   cannot drop it, and it would hand the credential to another host.
 * Nothing but the fixed settings when git cannot tell.
 */
export async function pushGuard(
  run: RunFn,
  path: string,
  env: Record<string, string>,
  url: string,
  ownLogin: boolean,
): Promise<PushGuard> {
  const read = await run("git", ["-C", path, "config", "-z", "--show-scope", "--get-regexp", PUSH_KEYS], {
    env,
    timeoutMs: 20_000,
  });
  const entries = read.code === 0 ? parseConfig(read.stdout) : [];
  const planted = entries.filter(fromRepo);
  const owners = entries.filter((e) => !fromRepo(e));
  const pushUrl = pushUrlFor(
    url,
    planted.flatMap((e) => (REWRITE.test(e.key) && e.value !== undefined ? [e.value] : [])),
  );
  if (pushUrl === undefined) {
    throw new Error(
      "The checkout's own git config rewrites the address of this push to another one, and majhi could not push around it. Ask the lead to remove the url.<base>.insteadOf lines from the checkout's git config.",
    );
  }
  const settings: [string, string][] = [["push.gpgSign", "false"]];
  if (pushUrl.override) {
    // Git rewrites with the longest matching value, and the first of equal ones. The address itself, as
    // its own rewrite, is longer than any value that is only its beginning, so the repo's rewrite never applies.
    settings.push(
      [`url.${pushUrl.url}.insteadOf`, pushUrl.url],
      [`url.${pushUrl.url}.pushInsteadOf`, pushUrl.url],
    );
  }
  for (const key of new Set(planted.map((e) => e.key))) {
    if (key !== "core.askpass" && key !== "core.alternaterefscommand") continue;
    const own = owners.filter((e) => e.key === key && e.value !== undefined).at(-1)?.value;
    settings.push([key, own ?? ""]);
  }
  if (ownLogin && planted.some((e) => HELPER.test(e.key))) {
    settings.push(["credential.helper", ""]);
    for (const e of owners) if (HELPER.test(e.key) && e.value !== undefined) settings.push([e.key, e.value]);
  }
  const out: Record<string, string> = {
    GIT_ALLOW_PROTOCOL: "https",
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return { options: ["--receive-pack=git-receive-pack"], env: out, url: pushUrl.url };
}
