import type { DeployEnvironment, DeployRunStep } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "../projects/service.ts";
import { type DiscoverInput, discoverEnvironments } from "./discover.ts";
import { DeployDiscovery } from "./discovery.ts";
import { nextPatch } from "./recipe.ts";
import {
  ACME_SHOP_FILES,
  ACME_SHOP_GITLAB_FILES,
  acmeShopCi,
  BUILD_BY_COMMIT,
  memoryCi,
} from "./testing/acme-shop.ts";
import { C1, rig } from "./testing/rig.ts";

/**
 * How a project deploys, read from its own CI files (docs/DECISIONS.md, "deploy from CI"): the sample `acme-shop` has a
 * build, a release with one target per client environment, a rollback, and a GitLab pipeline left behind.
 */

const FOLDERS = ["backend", "frontend", "docs"];

async function discover(over: Partial<DiscoverInput> = {}, files: Record<string, string> = ACME_SHOP_FILES) {
  return discoverEnvironments({
    files: await acmeShopCi(files),
    base: "main",
    provider: "github",
    remote: "origin",
    folders: FOLDERS,
    ...over,
  });
}

const build: DeployRunStep = {
  kind: "github-workflow",
  remote: "origin",
  workflow: "build-image.yml",
  ref: "base",
  bind: { version: "next-version", source_ref: "commit" },
};

describe("finding how a project deploys from its CI files", () => {
  it("reads one environment per target with the runs that deploy and put it back, asks instead of guessing, and reads a GitLab job", async () => {
    const { environments } = await discover();
    expect(environments.map((e) => [e.env, e.tier])).toEqual([
      ["acme", "production"],
      ["globex", "production"],
      ["initech", "production"],
    ]);
    const globex = environments[1]?.recipe;
    expect(globex).toEqual({
      from: { file: ".github/workflows/release.yml", line: 6 },
      // The build for the commit, then the release with the version the build made and the commit.
      deploy: [
        build,
        {
          kind: "github-workflow",
          remote: "origin",
          workflow: "release.yml",
          ref: "base",
          inputs: { target: "globex" },
          bind: { source_ref: "commit", components: "components", backend_version: "built-version" },
        },
      ],
      // The rollback workflow with the version and the commit the environment ran before.
      rollback: {
        at: "deployed",
        runs: [
          {
            kind: "github-workflow",
            remote: "origin",
            workflow: "rollback.yml",
            ref: "base",
            inputs: { target: "globex" },
            bind: {
              components: "components",
              backend_version: "previous-version",
              source_ref: "previous-commit",
            },
          },
        ],
      },
      // The release's title names the target, so its successful runs say when this environment was last deployed from GitHub.
      history: {
        remote: "origin",
        workflow: "release.yml",
        parts: [
          { kind: "text", text: "Deploy " },
          { kind: "input", name: "target" },
          { kind: "text", text: " " },
          { kind: "input", name: "components" },
          { kind: "text", text: " from " },
          { kind: "input", name: "source_ref" },
        ],
        match: { target: "globex" },
      },
      // The build takes its version as an input, so majhi picks it; the titles of its runs hold the versions built.
      pick: {
        input: "version",
        runs: {
          remote: "origin",
          workflow: "build-image.yml",
          parts: [
            { kind: "text", text: "Build backend " },
            { kind: "input", name: "version", fallback: "next version" },
            { kind: "text", text: " from " },
            { kind: "input", name: "source_ref", fallback: "main" },
          ],
          ref: "source_ref",
        },
      },
      // The release's title has no version, so what runs now is read from the image of the running containers.
      running: { repo: "registry.acme.example/acme-shop/backend", whole: true },
      // Both parts have a folder of their own, so a change picks backend, frontend or both by its files.
      components: {
        all: "both",
        parts: [
          { option: "backend", folder: "backend" },
          { option: "frontend", folder: "frontend" },
        ],
      },
      asks: [],
      answers: {},
    });

    // A build that names its image by the commit alone needs no version picked, and asks nothing.
    const byCommit = await discover(
      {},
      { ...ACME_SHOP_FILES, ".github/workflows/build-image.yml": BUILD_BY_COMMIT },
    );
    expect(byCommit.environments[0]?.recipe).toMatchObject({
      build: [
        { kind: "text", text: "sha-" },
        { kind: "commit", length: 40 },
      ],
      asks: [],
    });
    expect(byCommit.environments[0]?.recipe?.pick).toBeUndefined();

    // Parts with no folder are asked, and with no rollback workflow the release itself goes back.
    const files = { ...ACME_SHOP_FILES };
    delete files[".github/workflows/rollback.yml"];
    const bare = await discover({ folders: ["docs"] }, files);
    const acme = bare.environments[0]?.recipe;
    expect(acme?.asks.map((a) => [a.key, a.options])).toEqual([
      ["components", ["both", "backend", "frontend"]],
    ]);
    expect(acme?.components).toBeUndefined();
    // Without a rollback workflow, the release itself runs again with the version and the commit before.
    expect(acme?.rollback?.runs).toEqual([
      {
        kind: "github-workflow",
        remote: "origin",
        workflow: "release.yml",
        ref: "base",
        inputs: { target: "acme" },
        bind: {
          source_ref: "previous-commit",
          components: "components",
          backend_version: "previous-version",
        },
      },
    ]);

    // A GitLab job with an environment: a manual one is a job to play, a branch one is a merge.
    const gitlab = await discover({ provider: "gitlab" });
    expect(gitlab.environments.map((e) => [e.env, e.tier, e.branch, e.recipe?.deploy])).toEqual([
      [
        "production",
        "production",
        undefined,
        [{ kind: "gitlab-job", remote: "origin", job: "deploy-production" }],
      ],
      ["staging", "staging", "stg", [{ kind: "gitlab-merge", remote: "origin", branch: "stg" }]],
    ]);
    // A manual job goes back by running the job that deployed the commit before it again.
    expect(gitlab.environments[0]?.recipe?.rollback).toMatchObject({ at: "previous" });
    expect(gitlab.environments[0]?.recipe?.from).toEqual({ file: ".gitlab-ci.yml", line: 5 });
  });

  it("reads each GitLab target as a manual job with its confirmation, version and parts, linked to the build of its registry", async () => {
    const found = await discoverEnvironments({
      files: await acmeShopCi(ACME_SHOP_GITLAB_FILES),
      base: "main",
      provider: "gitlab",
      remote: "gitlab",
      folders: FOLDERS,
      read: memoryCi(ACME_SHOP_GITLAB_FILES).read,
    });
    // One production environment per deploy job. A status job reads a target and a build job makes an image: neither is a place to deploy.
    expect(found.environments.map((e) => [e.env, e.tier])).toEqual([
      ["acme", "production"],
      ["globex", "production"],
      ["initech", "production"],
    ]);
    const buildOf = (registry: string) => ({
      kind: "gitlab-job",
      remote: "gitlab",
      job: `image:build:${registry}`,
      bind: { VERSION: "next-version" },
    });
    const deployOf = (target: string, bind: Record<string, string>) => ({
      kind: "gitlab-job",
      remote: "gitlab",
      job: `app:deploy:${target}`,
      // TARGET from the job, and the confirmation the script compares with it.
      variables: { TARGET: target, CONFIRM_TARGET: target },
      bind,
    });
    const statusOf = (target: string) => ({
      kind: "gitlab-job",
      remote: "gitlab",
      job: `app:status:${target}`,
      variables: { TARGET: target },
    });
    const [acme, globex, initech] = found.environments.map((e) => e.recipe);
    // acme and initech share the production registry's build, globex has its own: the target's settings file says which.
    const forward = { COMPONENTS: "components", VERSION: "built-version" };
    expect(acme?.deploy).toEqual([buildOf("production"), deployOf("acme", forward), statusOf("acme")]);
    expect(globex?.deploy).toEqual([buildOf("globex"), deployOf("globex", forward), statusOf("globex")]);
    expect(initech?.deploy).toEqual([
      buildOf("production"),
      deployOf("initech", forward),
      statusOf("initech"),
    ]);
    expect(acme?.pick).toEqual({ input: "VERSION", registry: "production" });
    expect(globex?.pick).toEqual({ input: "VERSION", registry: "globex" });
    // The image each registry makes is what the containers are read for.
    expect(acme?.running).toEqual({ repo: "registry.acme.example/acme-shop/backend", whole: true });
    expect(globex?.running).toEqual({ repo: "registry.globex.example/acme-shop/backend", whole: true });
    // The rollback is the same deploy job with the version before, in a pipeline of its own.
    expect(acme?.rollback).toEqual({
      at: "deployed",
      runs: [
        { ...deployOf("acme", { COMPONENTS: "components", VERSION: "previous-version" }), fresh: true },
        statusOf("acme"),
      ],
    });
    // The parts come from the variable's options, the folders from the repo, and the frontend takes no version.
    expect(acme?.components).toEqual({
      all: "both",
      parts: [
        { option: "backend", folder: "backend" },
        { option: "frontend", folder: "frontend" },
      ],
      versionless: ["frontend"],
    });
    expect(acme?.live).toEqual({ kind: "gitlab-environment", remote: "gitlab", name: "app/acme" });
    expect(acme?.from.file).toBe(".gitlab/ci/deploy.yml");
    expect(acme?.asks).toEqual([]);

    // Without the settings files the YAML cannot say which registry a target uses: majhi asks once, and offers the builds.
    const bare = await discoverEnvironments({
      files: await acmeShopCi(ACME_SHOP_GITLAB_FILES),
      base: "main",
      provider: "gitlab",
      remote: "gitlab",
      folders: FOLDERS,
    });
    const asked = bare.environments[0]?.recipe;
    expect(asked?.asks).toEqual([
      {
        key: "registry",
        question: expect.stringContaining("Which registry does acme use"),
        options: ["image:build:production", "image:build:globex"],
      },
    ]);
    expect(asked?.deploy.map((r) => (r.kind === "gitlab-job" ? r.job : r.kind))).toEqual([
      "app:deploy:acme",
      "app:status:acme",
    ]);
    expect(asked?.builds).toEqual([buildOf("production"), buildOf("globex")]);
  });

  it("takes the recipe of the host that deploys an environment: the newest successful deploy wins, and with no history it asks once", async () => {
    // The sample project builds on GitHub and deploys three targets from GitLab; both describe the same environments.
    const files = { ...ACME_SHOP_FILES, ...ACME_SHOP_GITLAB_FILES };
    const remotes = { origin: "github", gitlab: "gitlab" } as const;
    const remoteOf = (env: DeployEnvironment) => env.recipe?.live?.remote ?? env.recipe?.history?.remote;

    async function read(
      lastDeploy: (remote: string | undefined) => string | undefined,
      saved: DeployEnvironment[] = [],
    ): Promise<DeployEnvironment[]> {
      let written: DeployEnvironment[] = [];
      // Only the fields discovery reads are given.
      const project = {
        id: "acme-shop",
        org: "acme",
        path: "/work/acme-shop",
        base: "main",
        exists: true,
        deploy: saved,
        deployDismissed: [],
        remotes: {},
      } as unknown as ProjectInfo;
      const repo = memoryCi(files);
      await new DeployDiscovery({
        projects: {
          get: async () => project,
          setEnvironments: async (_id, environments) => {
            written = [...environments];
          },
        },
        git: {
          tip: async () => C1,
          file: async (_p, _c, rel) => files[rel],
          list: async (_p, _c, dir) => repo.list(dir),
        },
        repoRef: async (_p, remote) => ({
          provider: remotes[(remote ?? "origin") as keyof typeof remotes],
          slug: "acme/acme-shop",
          host: "example.test",
        }),
        remoteOf: () => "origin",
        remotes: async () => ["origin", "gitlab"],
        lastDeploy: async (_p, env) => lastDeploy(remoteOf(env)),
        said: () => undefined,
      }).run("acme-shop");
      return written;
    }
    const remotesOf = (envs: DeployEnvironment[]) =>
      envs.map((e) => [e.env, e.recipe?.deploy.map((r) => ("remote" in r ? r.remote : "")).at(-1)]);

    // GitLab deployed most recently: its jobs deploy.
    const gitlab = await read((remote) =>
      remote === "gitlab" ? "2026-10-20T10:00:00Z" : "2026-10-01T10:00:00Z",
    );
    expect(remotesOf(gitlab)).toEqual([
      ["acme", "gitlab"],
      ["globex", "gitlab"],
      ["initech", "gitlab"],
    ]);
    // Only GitHub has a deploy: GitHub's workflow does.
    const github = await read((remote) => (remote === "origin" ? "2026-10-01T10:00:00Z" : undefined));
    expect(remotesOf(github)).toEqual([
      ["acme", "origin"],
      ["globex", "origin"],
      ["initech", "origin"],
    ]);
    // Neither has one: the first remote's recipe stands and asks which one, once.
    const none = await read(() => undefined);
    expect(none[0]?.recipe?.asks.find((a) => a.key === "deploy-via")).toMatchObject({
      options: ["origin", "gitlab"],
    });
    // The owner's answer, kept on the environment, decides at every later read.
    const [asked] = none;
    if (asked?.recipe === undefined) throw new Error("no environment");
    const answered = await read(
      () => undefined,
      [{ ...asked, recipe: { ...asked.recipe, answers: { "deploy-via": "gitlab" } } }],
    );
    expect(remotesOf(answered)[0]).toEqual(["acme", "gitlab"]);
    expect(answered[0]?.recipe?.asks.some((a) => a.key === "deploy-via")).toBe(false);

    // What each host says: GitLab's deployments of `app/<target>`, GitHub's successful release runs titled for the target.
    const r = await rig([], "github", remotes);
    try {
      r.hosts.runNames.set("release.yml", (i) => `Deploy ${i.target} ${i.components} from ${i.source_ref}`);
      r.hosts.seedRun({
        slug: "acme/storefront",
        workflow: "release.yml",
        sha: C1,
        inputs: { target: "globex", components: "both", source_ref: "main" },
        at: "2026-10-03T08:00:00Z",
      });
      r.hosts.seedRun({
        slug: "acme/storefront",
        workflow: "release.yml",
        sha: C1,
        inputs: { target: "acme", components: "both", source_ref: "main" },
        at: "2026-10-02T08:00:00Z",
      });
      r.hosts.deployments.set("app/acme", ["2026-10-04T09:00:00Z", "2026-09-01T09:00:00Z"]);
      const fromGithub = (await discover()).environments.find((e) => e.env === "acme");
      if (fromGithub === undefined) throw new Error("no acme");
      const gitlabEnv = await discoverEnvironments({
        files: await acmeShopCi(ACME_SHOP_GITLAB_FILES),
        base: "main",
        provider: "gitlab",
        remote: "gitlab",
        folders: FOLDERS,
        read: memoryCi(ACME_SHOP_GITLAB_FILES).read,
      });
      const lastOn = (env: DeployEnvironment | undefined) =>
        env === undefined ? undefined : r.service.lastDeployAt(r.project, env);
      expect(await lastOn(fromGithub)).toBe("2026-10-02T08:00:00Z");
      expect(await lastOn(gitlabEnv.environments.find((e) => e.env === "acme"))).toBe("2026-10-04T09:00:00Z");
      // A target nothing has deployed has no history.
      expect(await lastOn(gitlabEnv.environments.find((e) => e.env === "initech"))).toBeUndefined();
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });

  it("picks the next version in the shape of the target's own tag", () => {
    // A prefixed tag keeps its prefix, and the plain tags of the same registry do not count for it.
    expect(nextPatch(["pyzasoft-1.2.3", "9.9.9", "pyzasoft-1.1.8"], "pyzasoft-1.2.0")).toEqual({
      version: "pyzasoft-1.2.4",
      after: "pyzasoft-1.2.3",
    });
    expect(nextPatch(["pyzasoft-1.2.3", "1.4.7", "1.4.2"], "1.4.0")).toEqual({
      version: "1.4.8",
      after: "1.4.7",
    });
    // A suffix is kept too, and a tag with no three numbers is not a version.
    expect(nextPatch(["2.0.9-lts", "latest", "2.0"], "2.0.1-lts")?.version).toBe("2.0.10-lts");
    expect(nextPatch(["latest", "sha-ab12cd"], undefined)).toBeUndefined();
  });
});
