import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmd, type Proof } from "./deploy-proof.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(
  what: string,
  read: () => Promise<T | undefined> | T | undefined,
  ms = 90_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got !== undefined) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** Watches, deploy targets and the captain's rules of the proof's workspace, and the helpers the flows use. */
export async function prepare(proof: Proof) {
  const { url, hosts } = proof;
  const watch = async (name: string, path: string) =>
    (
      await cmd(url, "watch.save", {
        org: "acme",
        def: {
          name,
          spec: { kind: "website", url: `${hosts.url}${path}` },
          condition: { type: "above", value: 3000 },
          everyMin: 5,
        },
      })
    ).id as string;
  const stagingWatch = await watch("storefront-staging", "/health/staging");
  const prodWatch = await watch("storefront-prod", "/health/production");
  await cmd(url, "projects.setDeploy", {
    project: "storefront",
    target: {
      env: "staging",
      via: { kind: "github-workflow", connection: "acme-github", workflow: "deploy.yml", ref: "base" },
      verify: { health: `${hosts.url}/health/staging`, watch: stagingWatch, waitSeconds: 2 },
      rollback: { kind: "redeploy-previous" },
    },
  });
  await cmd(url, "projects.setDeploy", {
    project: "storefront",
    target: {
      env: "production",
      via: {
        kind: "ssh",
        connection: "acme-host",
        command: 'echo "$(date +%s)" > /srv/storefront/RELEASE && echo deployed',
      },
      verify: { health: `${hosts.url}/health/production`, watch: prodWatch, waitSeconds: 2 },
      rollback: {
        kind: "ssh",
        connection: "acme-host",
        command: "echo rolled-back > /srv/storefront/RELEASE",
      },
    },
  });
  await cmd(url, "autonomy.configure", {
    orgs: {
      acme: {
        authority: { merge: "decide", push: "ask", deployStaging: "decide", deployProduction: "ask" },
        ships: [
          {
            id: "bug12345",
            when: { types: ["bug"], maxChangedLines: 200 },
            merge: "decide",
            deployStaging: "decide",
            deployProduction: "ask",
            tell: "ask",
          },
        ],
      },
    },
  });
  await cmd(url, "autonomy.start", {});

  const makeTask = async (title: string, file: string) => {
    const task = await proof.majhi.services.tasks.createChange({
      text: title,
      project: "storefront",
      message: `fix: ${title}`,
      reason: "proof",
      change: async ({ worktree }) => writeFileSync(join(worktree, file), `${title}\n`),
    });
    await cmd(url, "tasks.setType", { id: task.id, type: "bug" });
    // The project works through merge requests on the (fake) host, and that part is phase B's: the owner merges
    // locally here, which is what lands the work. The captain's deploy pass takes it from there.
    await cmd(url, "tasks.merge", { id: task.id, done: true });
    return task.id as string;
  };
  const landed = async (id: string) =>
    (await cmd(url, "tasks.get", { id })).repos.find((r: { landed?: unknown }) => r.landed !== undefined)
      ?.landed as { commit: string } | undefined;

  const history = async () =>
    (await cmd(url, "projects.deployView", { project: "storefront" })).history as {
      id: number;
      env: string;
      commit: string;
      state: string;
      by: string;
      incident?: string;
      rollback?: { commit?: string };
      reason?: string;
      check?: { detail: string };
    }[];
  return { makeTask, landed, history, stagingWatch, prodWatch };
}
