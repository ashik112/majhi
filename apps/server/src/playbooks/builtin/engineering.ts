import type { Playbook } from "@majhi/shared";

/**
 * The engineering pack. Both playbooks need a sensor that is not built yet (captain v2, step 9: CI
 * status, lockfiles checked against advisories), so they are off and say so. They are written now so the
 * owner sees what is coming and the sensors have a place to plug in.
 */

export const ENGINEERING_PLAYBOOKS: Playbook[] = [
  {
    id: "eng-ci-health",
    name: "CI health",
    purpose: "Watch each project's CI and file a finding when the default branch fails or turns flaky.",
    pack: "engineering",
    trigger: { cadence: { kind: "every", minutes: 360 }, events: ["A CI run finishes"] },
    scope: "workspace",
    inputs: ["CI status of each project's default branch"],
    steps:
      "Read the CI status the sensor reports. For a failing default branch, or a test that failed and passed on the same commit, report one finding per cause with the run link as evidence, severity medium. Report nothing when CI is green.",
    outputs: ["finding"],
    channels: [],
    cost: { tier: "small", tokens: 30_000 },
    enabledByDefault: false,
    needs: "A CI status sensor. It arrives with the sensors (captain v2, step 9).",
    turnOn: "Files a finding when CI fails or turns flaky. Needs the CI sensor first.",
    runner: { kind: "captain" },
    settings: [],
  },
  {
    id: "eng-dependency-sweep",
    name: "Dependency and security sweep",
    purpose: "Check each project's lockfile for known vulnerabilities and file a finding for each real one.",
    pack: "engineering",
    trigger: { cadence: { kind: "weekly", day: 1, at: "08:00" }, events: ["A lockfile changes"] },
    scope: "workspace",
    inputs: ["Lockfiles of registered projects", "Advisories for the packages in them"],
    steps:
      "Read the advisories the sensor matched to each lockfile. For one that applies to a package the code uses, report one finding with the package, version, fix version and advisory link, severity by the advisory. Skip dev-only packages that never ship.",
    outputs: ["finding", "task"],
    channels: [],
    cost: { tier: "small", tokens: 40_000 },
    enabledByDefault: false,
    needs: "A lockfile and advisory sensor. It arrives with the sensors (captain v2, step 9).",
    turnOn: "Files a finding for each known vulnerability in a lockfile. Needs the advisory sensor first.",
    runner: { kind: "captain" },
    settings: [],
  },
];
