import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createE2eRunner } from "./e2e.ts";
import { ensureAskpass } from "./gitAuth.ts";
import { gitLsRemote } from "./gitClone.ts";
import { gitPush } from "./gitPush.ts";
import { commitSubjects, readRepo } from "./repoInfo.ts";
import { runCommand } from "./runCommand.ts";

const exec = promisify(execFile);
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const ID = ["-c", "user.name=T", "-c", "user.email=t@acme.test"];

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

/** A folder for one test, with a marker file the planted commands write to. */
async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-guard-")));
  dirs.push(dir);
  const marker = join(dir, "ran");
  /** The owner's own git: plain, with `dir` as HOME (its `.gitconfig` is the owner's). */
  const env = { PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
  const plain = (cwd: string, ...args: string[]) =>
    exec("git", ["-C", cwd, ...args], { env }).then((r) => r.stdout.trim());
  const script = async (name: string, body: string) => {
    const file = join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  return {
    dir,
    plain,
    script,
    say: (what: string) => `echo ${what} >> '${marker}'`,
    ran: () => readFile(marker, "utf8").catch(() => ""),
  };
}

/**
 * An https git server on 127.0.0.1 for the bare repos in `root`: `git http-backend` behind a
 * self-signed certificate, which asks for a password once.
 */
async function httpsGit(root: string, dir: string) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  await exec("openssl", [
    ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1"],
    ...["-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert],
  ]);
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    if (req.headers.authorization === undefined) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="acme"' }).end();
      return;
    }
    const url = new URL(req.url ?? "/", "https://127.0.0.1");
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "t",
        REMOTE_ADDR: "127.0.0.1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        ...(req.headers["content-length"] === undefined
          ? {}
          : { CONTENT_LENGTH: req.headers["content-length"] }),
      },
    });
    req.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("close", () => {
      const out = Buffer.concat(chunks);
      const end = out.indexOf("\r\n\r\n");
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of out.subarray(0, end).toString().split("\r\n")) {
        const at = line.indexOf(": ");
        if (line.slice(0, at).toLowerCase() === "status") status = Number.parseInt(line.slice(at + 2), 10);
        else headers[line.slice(0, at)] = line.slice(at + 2);
      }
      res.writeHead(status, headers).end(out.subarray(end + 4));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { cert, base: `https://127.0.0.1:${port}`, close: () => server.close() };
}

describe("the helper's git in a repo whose config names commands", () => {
  it("ls-remote runs no upload-pack, proxy or ext:: command of the repo it starts in", async () => {
    const { dir, plain, script, say, ran } = await setup();
    const bare = join(dir, "up.git");
    await plain(dir, "init", "-q", "--bare", "-b", "main", bare);
    const planted = join(dir, "planted");
    await plain(dir, "init", "-q", planted);
    // What an agent could plant in a repo the helper starts in.
    const proxy = await script("proxy.sh", `${say("git-proxy")}\nexit 1`);
    const ext = await script("ext.sh", `${say("ext")}\nexit 1`);
    for (const [key, value] of [
      [`remote.file://${bare}.uploadpack`, `${say("uploadpack")}; git-upload-pack`],
      ["core.gitProxy", proxy],
      ["protocol.ext.allow", "always"],
    ] as const) {
      await plain(planted, "config", key, value);
    }
    const majhiHome = join(dir, ".majhi");
    const deps = {
      majhiHome,
      askpass: await ensureAskpass(majhiHome),
      path: PATH,
      home: dir,
      run: ((file, args, o) => runCommand(file, args, { ...o, cwd: planted })) as typeof runCommand,
      socket: async () => undefined,
    };
    const none = { kind: "none" } as const;
    expect(await gitLsRemote(deps, { url: `file://${bare}`, auth: none })).toEqual({ empty: true });
    await expect(gitLsRemote(deps, { url: "git://127.0.0.1:1/x.git", auth: none })).rejects.toThrow();
    await expect(gitLsRemote(deps, { url: `ext::${ext}`, auth: none })).rejects.toThrow();
    expect(await ran()).toBe("");

    // The same repo with plain git does run them, so the setup above is live.
    for (const url of [`file://${bare}`, "git://127.0.0.1:1/x.git", `ext::${ext}`]) {
      await plain(planted, "ls-remote", url).catch(() => undefined);
    }
    expect(await ran()).toBe("uploadpack\ngit-proxy\next\n");
  });

  it("a push runs no hook, credential helper or signing program of the checkout's, and no rewrite", async () => {
    const { dir, plain, script, say, ran } = await setup();
    const root = join(dir, "served");
    await mkdir(root);
    for (const name of ["up.git", "other.git"]) {
      await plain(dir, "init", "-q", "--bare", "-b", "main", join(root, name));
      await plain(join(root, name), "config", "receive.certNonceSeed", "acme");
    }
    const server = await httpsGit(root, dir);
    try {
      const url = `${server.base}/up.git`;
      // The owner's own config: trusts the test server, and a helper that logs in.
      await writeFile(
        join(dir, ".gitconfig"),
        `[http]\n\tsslCAInfo = ${server.cert}\n[credential]\n\thelper = "!f() { ${say("owner-helper")}; test $1 = get && printf 'username=t\\\\npassword=t\\\\n'; }; f"\n`,
      );
      const work = join(dir, "work");
      await plain(dir, "init", "-q", "-b", "main", work);
      await writeFile(join(work, "a.txt"), "one\n");
      await plain(work, "add", "a.txt");
      await plain(work, ...ID, "commit", "-qm", "one");

      // What an agent could plant in the checkout: hooks, a credential helper, and a signing
      // program the server asks for (it offers signed pushes).
      const hooks = join(dir, "hooks");
      await mkdir(hooks);
      for (const name of ["pre-push", "reference-transaction"]) {
        await writeFile(join(hooks, name), `#!/bin/sh\n${say(name)}\n`, { mode: 0o755 });
      }
      const gpg = await script(
        "gpg.sh",
        `${say("gpg")}\ncat > /dev/null\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 1 X\\n' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n'`,
      );
      for (const [key, value] of [
        ["remote.origin.url", url],
        ["core.hooksPath", hooks],
        ["credential.helper", `!f() { ${say("repo-helper")}; }; f`],
        ["push.gpgSign", "if-asked"],
        ["gpg.program", gpg],
        ["user.name", "T"],
        ["user.email", "t@acme.test"],
      ] as const) {
        await plain(work, "config", key, value);
      }

      const deps = { run: runCommand, home: dir, path: PATH, kind: async () => "directory" as const };
      await gitPush(deps, { path: work, url, branch: "main", setUpstream: true });
      expect(await plain(join(root, "up.git"), "rev-parse", "main")).toBe(
        await plain(work, "rev-parse", "main"),
      );
      expect(await plain(work, "rev-parse", "origin/main")).toBe(await plain(work, "rev-parse", "main"));
      const asked = await ran();
      expect(asked).toMatch(/^(owner-helper\n)+$/);

      // A rewrite the checkout's config makes is refused before git runs.
      await plain(work, "config", `url.${server.base}/other.git.pushInsteadOf`, url);
      await expect(gitPush(deps, { path: work, url, branch: "main" })).rejects.toThrow(/another URL/);
      await expect(plain(join(root, "other.git"), "rev-parse", "--verify", "main")).rejects.toThrow();
      expect(await ran()).toBe(asked);

      // The same checkout with plain git does run them, so the setup above is live.
      await plain(work, "push", "--quiet", url, "main:refs/heads/plain").catch(() => undefined);
      await plain(work, "update-ref", "refs/heads/probe", "HEAD");
      expect((await ran()).slice(asked.length).split("\n")).toEqual(
        expect.arrayContaining(["repo-helper", "pre-push", "gpg", "reference-transaction"]),
      );
      expect(await plain(join(root, "other.git"), "rev-parse", "plain")).toBe(
        await plain(work, "rev-parse", "main"),
      );
    } finally {
      server.close();
    }
  });
});

describe("the helper's git in a majhi checkout whose shared .git/config names commands", () => {
  /**
   * A checkout with two commits, the second signed, and what an agent could plant in its config:
   * fsmonitor, a clean filter, a process filter and a signature check with its own program.
   */
  async function planted() {
    const t = await setup();
    const { dir, plain, script, say } = t;
    const gpg = await script(
      "gpg.sh",
      `${say("gpg")}\ncat > /dev/null\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 1 X\\n' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n'`,
    );
    const repo = join(dir, "majhi");
    await plain(dir, "init", "-q", "-b", "main", repo);
    await writeFile(join(repo, ".gitattributes"), "a.txt filter=a\nb.txt filter=b\n");
    await writeFile(join(repo, "a.txt"), "one\n");
    await writeFile(join(repo, "b.txt"), "one\n");
    await plain(repo, "add", "-A");
    await plain(repo, ...ID, "commit", "-qm", "one");
    const first = await plain(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "a.txt"), "two\n");
    await plain(repo, ...ID, "-c", `gpg.program=${gpg}`, "commit", "-S", "-qam", "two");
    for (const [key, value] of [
      ["core.fsmonitor", await script("fsmonitor.sh", `${say("fsmonitor")}\nexit 1`)],
      ["filter.a.clean", await script("clean.sh", `${say("clean")}\nexit 1`)],
      ["filter.a.smudge", await script("smudge.sh", `${say("smudge")}\nexit 1`)],
      ["filter.b.process", await script("process.sh", `${say("process")}\nexit 1`)],
      ["log.showSignature", "true"],
      ["gpg.program", gpg],
    ] as const) {
      await plain(repo, "config", key, value);
    }
    // Signing the commit above ran the fake gpg: start the marker over.
    await rm(join(dir, "ran"), { force: true });
    return { ...t, repo, first };
  }

  /** Makes the checkout's files stat-dirty: same content, a new mtime, so status hashes them again. */
  const touch = async (repo: string) => {
    const later = new Date(Date.now() + 3_600_000);
    for (const name of ["a.txt", "b.txt"]) await utimes(join(repo, name), later, later);
  };

  it("repo state and commit subjects run no fsmonitor, filter or signing program of the checkout's", async () => {
    const { dir, plain, ran, repo, first } = await planted();
    await touch(repo);
    const ctx = { git: "git", repo, env: { PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" }, exec };
    expect(await readRepo(ctx)).toEqual({ commit: await plain(repo, "rev-parse", "HEAD"), dirty: false });
    expect(await commitSubjects(ctx, first)).toEqual(["two"]);
    expect(await ran()).toBe("");

    // The same checkout with plain git does run them, so the setup above is live.
    await touch(repo);
    await plain(repo, "status", "--porcelain").catch(() => undefined);
    await plain(repo, "log", "--format=%s", `${first}..HEAD`);
    expect((await ran()).split("\n")).toEqual(
      expect.arrayContaining(["fsmonitor", "clean", "process", "gpg"]),
    );
  });

  it("the e2e worktree's checkout runs no filter of the checkout's", async () => {
    const { dir, plain, script, ran, repo, first } = await planted();
    const git = (await exec("which", ["git"], { env: { PATH } })).stdout.trim();
    // pnpm fails at once: the checkout is what is under test.
    const pnpm = await script("pnpm", "exit 1");
    const e2e = createE2eRunner({
      run: runCommand,
      majhiHome: join(dir, ".majhi"),
      home: dir,
      path: PATH,
      platform: "linux",
      find: async (name) => (name === "git" ? git : name === "pnpm" ? pnpm : undefined),
      log: () => undefined,
      freePort: async () => 54321,
    });
    const head = await plain(repo, "rev-parse", "HEAD");
    // The first run adds the worktree, the second moves it with checkout and cleans it.
    for (const [runId, commit] of [
      ["run-1", first],
      ["run-2", head],
    ] as const) {
      const result = await e2e({ runId, repo, commit, timeoutMs: 600_000 });
      expect(result.error).toBe("pnpm install failed in the e2e worktree.");
    }
    const worktree = join(dir, ".majhi", "e2e", "worktree");
    expect(await plain(worktree, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(worktree, "a.txt"), "utf8")).toBe("two\n");
    expect(await ran()).toBe("");

    // The same checkout with plain git does run them, so the setup above is live.
    await plain(repo, "worktree", "add", "-q", "--detach", join(dir, "plain"), first).catch(() => undefined);
    expect((await ran()).split("\n")).toContain("smudge");
  });
});
