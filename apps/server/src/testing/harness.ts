import { join } from "node:path";
import { COMMAND_META_HEADER } from "@majhi/shared";
import type { RemoteRunFn } from "../connections/remote.ts";
import type { ContainerDocker } from "../containers/service.ts";
import type { ServerEnv } from "../env.ts";
import type { HostLink } from "../host/link.ts";
import { type Embedder, HashEmbedder } from "../memory/embedder.ts";
import type { MrHostOptions } from "../mrs/hosts/index.ts";
import type { Probe } from "../runs/network.ts";
import { generateKey } from "../secrets/store.ts";
import type { Majhi } from "../server.ts";
import { createMajhi } from "../server.ts";
import type { LinkOptions } from "../tasks/links.ts";
import type { TrackerAdapter, TrackerAdapterInit } from "../trackers/types.ts";
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
  /** The host helper link, so a test can play the helper. */
  hostLink?: HostLink;
  /** The network probe, so a test can go offline. */
  probe?: Probe;
  /** The clock of agent runs and the network watch. */
  runClock?: () => Date;
  /** Fake `gh`, `glab` and Bitbucket for merge requests. */
  mrHosts?: MrHostOptions;
  /** Replaces the deterministic fake embedder. */
  embedder?: Embedder;
  /** Replaces the docker CLI of the containers majhi runs for agents. */
  containerDocker?: ContainerDocker;
  /** Replaces ssh for majhi-connections. */
  connectionsRemote?: RemoteRunFn;
  /** How long after a turn ends a silent room is looked at. */
  idleWatchMs?: number;
  /** Replaces `fetch` for git sign-in and the git hosts' APIs. */
  gitFetch?: typeof fetch;
  /** Replaces `fetch` for the trackers' APIs. */
  trackerFetch?: typeof fetch;
  /** Replaces the tracker adapters. */
  trackerAdapter?: (init: TrackerAdapterInit) => TrackerAdapter;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { dir, cleanup } = await tempDir();
  const env = testEnv(dir);
  if (options.key !== false) await writeKeyFile(env.secretsKeyFile, await generateKey());
  const runtime = fakeRuntime();
  const h = build(dir, env, runtime, cleanup, options);
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
  options: HarnessOptions,
): Harness {
  const { links, hostLink, probe, mrHosts } = options;
  const majhi = createMajhi(env, {
    runtime,
    // Never the real model: it would download.
    embedder: options.embedder ?? new HashEmbedder(),
    ...(links === undefined ? {} : { links }),
    ...(hostLink === undefined ? {} : { hostLink }),
    ...(probe === undefined ? {} : { probe }),
    ...(options.runClock === undefined ? {} : { runClock: options.runClock }),
    ...(mrHosts === undefined ? {} : { mrHosts }),
    ...(options.containerDocker === undefined ? {} : { containerDocker: options.containerDocker }),
    ...(options.connectionsRemote === undefined ? {} : { connectionsRemote: options.connectionsRemote }),
    ...(options.idleWatchMs === undefined ? {} : { idleWatchMs: options.idleWatchMs }),
    ...(options.gitFetch === undefined ? {} : { gitFetch: options.gitFetch }),
    ...(options.trackerFetch === undefined ? {} : { trackerFetch: options.trackerFetch }),
    ...(options.trackerAdapter === undefined ? {} : { trackerAdapter: options.trackerAdapter }),
  });
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
    restart: () => build(dir, env, runtime, cleanup, options),
    cleanup: async () => {
      await majhi.close();
      await cleanup();
    },
  };
  return h;
}
