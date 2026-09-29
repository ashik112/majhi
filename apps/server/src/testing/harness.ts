import { join } from "node:path";
import { COMMAND_META_HEADER } from "@majhi/shared";
import type { ServerEnv } from "../env.ts";
import { generateKey } from "../secrets/store.ts";
import type { Majhi } from "../server.ts";
import { createMajhi } from "../server.ts";
import type { LinkOptions } from "../tasks/links.ts";
import { type FakeRuntime, fakeRuntime } from "./fakeRuntime.ts";
import { git, tempDir, testEnv, writeKeyFile } from "./fixtures.ts";

export interface Harness {
  dir: string;
  env: ServerEnv;
  majhi: Majhi;
  runtime: FakeRuntime;
  /** Runs a command through the HTTP app and returns status and JSON body. */
  // biome-ignore lint/suspicious/noExplicitAny: test helper; each test asserts the fields it reads
  cmd(name: string, body?: unknown, meta?: unknown): Promise<{ status: number; body: any }>;
  /** Subjects of the config history, newest first. */
  log(format?: string): Promise<string[]>;
  /** A second server over the same home, like a restart. */
  restart(): Harness;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  /** Create the secrets key file. Default true. */
  key?: boolean;
  /** Set workspace roots so majhi.yaml exists. Default true. */
  workspaces?: boolean;
  /** Replaces `fetch` for task links. */
  links?: LinkOptions;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { dir, cleanup } = await tempDir();
  const env = testEnv(dir);
  if (options.key !== false) await writeKeyFile(env.secretsKeyFile, await generateKey());
  const runtime = fakeRuntime();
  const h = build(dir, env, runtime, cleanup, options.links);
  if (options.workspaces !== false) {
    const res = await h.cmd("workspaces.set", { workspaces: ["~/Work"] });
    if (res.status !== 200) throw new Error(`workspaces.set failed: ${JSON.stringify(res.body)}`);
  }
  return h;
}

function build(
  dir: string,
  env: ServerEnv,
  runtime: FakeRuntime,
  cleanup: () => Promise<void>,
  links?: LinkOptions,
): Harness {
  const majhi = createMajhi(env, { runtime, ...(links === undefined ? {} : { links }) });
  const h: Harness = {
    dir,
    env,
    majhi,
    runtime,
    async cmd(name, body, meta) {
      const res = await majhi.app.request(`/api/cmd/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(meta === undefined ? {} : { [COMMAND_META_HEADER]: JSON.stringify(meta) }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async log(format = "%s") {
      const out = await git(join(env.majhiHome), "log", `--format=${format}`);
      return out === "" ? [] : out.split("\n");
    },
    restart: () => build(dir, env, runtime, cleanup, links),
    cleanup: async () => {
      await majhi.close();
      await cleanup();
    },
  };
  return h;
}
