import type { ConnectionConfig, DeployTarget } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { checkDeploy } from "./service.ts";

const conn = (c: Partial<ConnectionConfig> & Pick<ConnectionConfig, "type">): ConnectionConfig =>
  ({ name: "c", ...c }) as ConnectionConfig;

const acme: Record<string, ConnectionConfig> = {
  "acme-github": conn({ type: "git", fields: { provider: "github" } }),
  "acme-gitlab": conn({ type: "git", fields: { provider: "gitlab" } }),
  "acme-host": conn({ type: "ssh", fields: { alias: "deploy@203.0.113.7" } }),
};

const target = (over: Partial<DeployTarget> = {}): DeployTarget => ({
  env: "staging",
  via: { kind: "github-workflow", connection: "acme-github", workflow: "deploy.yml", ref: "base" },
  verify: { health: "https://staging.acme.example/health", waitSeconds: 60 },
  rollback: { kind: "redeploy-previous" },
  ...over,
});

describe("saving deploy targets", () => {
  it("accepts a target through the workspace's own connection", () => {
    expect(() => checkDeploy("acme", [target()], acme)).not.toThrow();
  });

  it("refuses a connection the workspace does not have, so another workspace's cannot be named", () => {
    expect(() =>
      checkDeploy(
        "acme",
        [
          target({
            via: {
              kind: "github-workflow",
              connection: "globex-github",
              workflow: "deploy.yml",
              ref: "base",
            },
          }),
        ],
        acme,
      ),
    ).toThrow("staging: acme has no connection globex-github. Use one of this workspace's own.");
  });

  it("refuses a connection of the wrong kind", () => {
    expect(() =>
      checkDeploy(
        "acme",
        [
          target({
            via: { kind: "github-workflow", connection: "acme-gitlab", workflow: "deploy.yml", ref: "base" },
          }),
        ],
        acme,
      ),
    ).toThrow("staging: acme-gitlab is not a GitHub connection.");
    expect(() =>
      checkDeploy(
        "acme",
        [target({ via: { kind: "ssh", connection: "acme-github", command: "./deploy.sh" } })],
        acme,
      ),
    ).toThrow("staging: acme-github is not an SSH host.");
  });

  it("refuses a rollback that cannot go back to an earlier commit", () => {
    expect(() =>
      checkDeploy(
        "acme",
        [target({ via: { kind: "gitlab-pipeline", connection: "acme-gitlab", ref: "base" } })],
        acme,
      ),
    ).toThrow(
      "staging: A GitLab pipeline starts from a branch, not from an earlier commit. Write the rollback command.",
    );
    expect(() =>
      checkDeploy(
        "acme",
        [target({ via: { kind: "ssh", connection: "acme-host", command: "./deploy.sh" } })],
        acme,
      ),
    ).toThrow("An ssh command has no earlier commit to start from. Write the rollback command.");
    expect(() =>
      checkDeploy(
        "acme",
        [
          target({
            via: { kind: "ssh", connection: "acme-host", command: "./deploy.sh" },
            rollback: { kind: "ssh", connection: "acme-host", command: "./rollback.sh" },
          }),
        ],
        acme,
      ),
    ).not.toThrow();
  });
});
