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

interface ConfigEntry {
  scope: string;
  key: string;
  value: string | undefined;
}

export interface PushGuard {
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
  const listed = read.code === 0 ? read.stdout.split("\0") : [];
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < listed.length; i += 2) {
    const [scope = "", item = ""] = [listed[i], listed[i + 1]];
    const at = item.indexOf("\n");
    entries.push(
      at === -1
        ? { scope, key: item, value: undefined }
        : { scope, key: item.slice(0, at), value: item.slice(at + 1) },
    );
  }
  const fromRepo = (e: ConfigEntry) => e.scope === "local" || e.scope === "worktree";
  const planted = entries.filter(fromRepo);
  const owners = entries.filter((e) => !fromRepo(e));
  if (planted.some((e) => REWRITE.test(e.key) && e.value !== undefined && url.startsWith(e.value))) {
    throw new Error(
      "The checkout's own git config sends this push to another URL (url.<base>.insteadOf). Remove that setting from its .git/config, then push again.",
    );
  }
  const settings: [string, string][] = [["push.gpgSign", "false"]];
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
  return { options: ["--receive-pack=git-receive-pack"], env: out };
}
