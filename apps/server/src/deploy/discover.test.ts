import type { DeployRunStep } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type DiscoverInput, discoverEnvironments } from "./discover.ts";
import { ACME_SHOP_FILES, acmeShopCi } from "./testing/acme-shop.ts";

/**
 * How a project deploys, read from its own CI files (docs/briefs/deploy-from-ci.md): the sample `acme-shop` has a
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
  bind: { source_ref: "commit" },
};

describe("finding how a project deploys from its CI files", () => {
  it("reads one environment per target, with the runs that deploy it and the runs that put it back", async () => {
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
      // The build names its image by the commit, so the version is known before it runs.
      build: [
        { kind: "text", text: "sha-" },
        { kind: "commit", length: 40 },
      ],
      // The release's title holds the target and the version: that is how the live version is read back.
      live: {
        kind: "run-name",
        remote: "origin",
        workflow: "release.yml",
        parts: [
          { kind: "text", text: "Release " },
          { kind: "input", name: "target" },
          { kind: "text", text: " " },
          { kind: "input", name: "backend_version" },
        ],
        match: { target: "globex" },
        version: "backend_version",
      },
      // Both parts have a folder of their own, so a change picks backend, frontend or both by its files.
      components: {
        all: "both",
        parts: [
          { option: "backend", folder: "backend" },
          { option: "frontend", folder: "frontend" },
        ],
      },
      asks: [],
    });
  });

  it("asks instead of guessing: parts with no folder, and no rollback workflow means the release goes back", async () => {
    const files = { ...ACME_SHOP_FILES };
    delete files[".github/workflows/rollback.yml"];
    const { environments } = await discover({ folders: ["docs"] }, files);
    const acme = environments[0]?.recipe;
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
  });

  it("reads a GitLab job with an environment: a manual one is a job to play, a branch one is a merge", async () => {
    const { environments } = await discover({ provider: "gitlab" });
    expect(environments.map((e) => [e.env, e.tier, e.branch, e.recipe?.deploy])).toEqual([
      [
        "production",
        "production",
        undefined,
        [{ kind: "gitlab-job", remote: "origin", job: "deploy-production" }],
      ],
      ["staging", "staging", "stg", [{ kind: "gitlab-merge", remote: "origin", branch: "stg" }]],
    ]);
    // A manual job goes back by running the job that deployed the commit before it again.
    expect(environments[0]?.recipe?.rollback).toMatchObject({ at: "previous" });
    expect(environments[0]?.recipe?.from).toEqual({ file: ".gitlab-ci.yml", line: 5 });
  });
});
