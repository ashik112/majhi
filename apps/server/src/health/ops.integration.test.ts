import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HostInfo, HostJob, HostMethod } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostLink } from "../host/link.ts";
import { SystemService, UPDATE_WAIT_FILE } from "../system/service.ts";
import { tempDir } from "../testing/fixtures.ts";

const RUNNING = "aaaaaaa1111111111111111111111111111111aa";
const ON_DISK = "bbbbbbb2222222222222222222222222222222bb";
const INFO: HostInfo = {
  version: "1.0.0",
  platform: "darwin",
  canRemount: true,
  commit: ON_DISK,
  dirty: true,
};

type Answer = unknown | ((job: HostJob) => unknown);

/** Stands in for the host helper: polls the link and answers each job from `answers`. */
function fakeHelper(link: HostLink, info: HostInfo, answers: Partial<Record<HostMethod, Answer>>) {
  const seen: HostJob[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const job = await link.poll(info);
      if (job === undefined) continue;
      seen.push(job);
      const answer = answers[job.method];
      if (answer instanceof Error) link.reply({ id: job.id, ok: false, error: answer.message });
      else link.reply({ id: job.id, ok: true, result: typeof answer === "function" ? answer(job) : answer });
    }
  })();
  return {
    seen,
    async stop() {
      stopped = true;
      link.close();
      await loop;
    },
  };
}

describe("Update when they finish", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let link: HostLink;
  let helper: ReturnType<typeof fakeHelper> | undefined;
  const services: SystemService[] = [];
  let working = 1;

  const system = () => {
    const s = new SystemService({
      hostLink: link,
      commit: RUNNING,
      majhiHome: dir,
      working: () => working,
      waitPollMs: 5,
    });
    services.push(s);
    return s;
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    working = 1;
    link = new HostLink({ pollTimeoutMs: 20 });
    helper = fakeHelper(link, INFO, { update: { accepted: true } });
    await until(() => link.isConnected());
  });
  afterEach(async () => {
    for (const s of services.splice(0)) s.close();
    await helper?.stop();
    await cleanup();
  });

  it("keeps waiting across a restart and starts the update once the agents are done", async () => {
    expect(await system().update("idle")).toEqual({ state: "waiting" });
    expect(existsSync(join(dir, UPDATE_WAIT_FILE))).toBe(true);
    // majhi restarts while agents still work: the new server picks the wait up.
    for (const s of services.splice(0)) s.close();
    const after = system();
    expect(await after.restore()).toBe(true);
    expect(after.waiting).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(helper?.seen.map((j) => j.method)).toEqual([]);

    working = 0;
    await until(() => (helper?.seen.length ?? 0) > 0);
    expect(helper?.seen.map((j) => j.method)).toEqual(["update"]);
    expect(after.waiting).toBe(false);
    expect(existsSync(join(dir, UPDATE_WAIT_FILE))).toBe(false);
  });
});
