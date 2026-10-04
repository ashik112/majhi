import type { Playbook } from "@majhi/shared";
import { healthRules } from "./health-rules.ts";

/**
 * The engineering pack: five sensors (captain v2, step 9; `apps/server/src/sensors`). They are cheap
 * code with no model turn (the radar asks the smallest model one question per new release, under a
 * weekly token budget), read only, and file findings. They are on by default: a workspace with no
 * registered project simply has nothing for them to look at. They run while Autonomous is off, because
 * nothing they do acts on anything; the findings wait.
 */

const READ_ONLY = { cost: { tier: "rules", tokens: 0 }, readOnly: true, enabledByDefault: true } as const;

export const ENGINEERING_PLAYBOOKS: Playbook[] = [
  {
    id: "eng-ci-health",
    name: "CI health",
    purpose: "Watch each project's CI and file a finding when the default branch fails or turns flaky.",
    pack: "engineering",
    trigger: { cadence: { kind: "every", minutes: 360 }, events: ["A CI run finishes"] },
    scope: "workspace",
    inputs: [
      "Pipeline runs of the default branch and of open task branches, through the workspace's git sign-in",
    ],
    steps:
      "Ask the git host for the latest runs of each project's default branch and open task branches, only when the branch head moved. A failing default branch, or a run that failed and then passed on the same commit, files one finding with the run link as evidence. A green run closes it.",
    outputs: ["finding"],
    channels: [],
    ...READ_ONLY,
    turnOn:
      "Files a finding when CI fails or turns flaky on GitHub or GitLab. Needs the workspace signed in to that host.",
    runner: { kind: "rules", id: "sensor-ci" },
    outcomes: healthRules("ci", "CI fails or turns flaky"),
    settings: [],
  },
  {
    id: "eng-dependency-sweep",
    name: "Dependency sweep",
    purpose: "Check each project's lockfiles for known vulnerabilities and for dependencies far behind.",
    pack: "engineering",
    trigger: { cadence: { kind: "daily", at: "07:00" }, events: ["A lockfile changes"] },
    scope: "workspace",
    inputs: [
      "Tracked lockfiles of registered projects (read only)",
      "Advisories for the package names and versions in them (osv.dev)",
      "Latest versions from the package registry",
    ],
    steps:
      "Read the lockfiles, ask OSV about the pinned versions (only when a lockfile changed, or once a day for new advisories) and file one security finding per advisory and package with the fixed version. File a dependency finding for a direct dependency two or more majors behind. A fixed advisory closes its finding.",
    outputs: ["finding"],
    channels: [],
    ...READ_ONLY,
    turnOn:
      "Files a finding for each known vulnerability in a lockfile and for dependencies two majors behind. Sends package names and versions to osv.dev and the registry, nothing else.",
    runner: { kind: "rules", id: "sensor-deps" },
    outcomes: healthRules("deps", "A vulnerable or far-behind package"),
    settings: [],
  },
  {
    id: "eng-security-sweep",
    name: "Secret scan",
    purpose:
      "Scan each project's tracked files for committed secrets and file a finding with the file and line.",
    pack: "engineering",
    trigger: { cadence: { kind: "daily", at: "07:30" }, events: [] },
    scope: "workspace",
    inputs: ["Tracked files of registered projects (read only)"],
    steps:
      "Run the secret detector over the tracked files, only when the checkout changed or a week passed. File one security finding per file and kind of secret with the file and line numbers. The value is never shown, stored or sent anywhere.",
    outputs: ["finding"],
    channels: [],
    ...READ_ONLY,
    turnOn:
      "Files a finding when a tracked file holds what looks like a secret, with the file and line but never the value. Nothing leaves your machine.",
    runner: { kind: "rules", id: "sensor-secrets" },
    outcomes: healthRules("secrets", "A secret in a tracked file"),
    settings: [],
  },
  {
    id: "eng-eol-watch",
    name: "End-of-life watch",
    purpose: "Warn when a project's runtime or database is past its end of life or within 90 days of it.",
    pack: "engineering",
    trigger: { cadence: { kind: "weekly", day: 1, at: "07:00" }, events: [] },
    scope: "workspace",
    inputs: ["The runtimes on each project card", "End-of-life dates from endoflife.date"],
    steps:
      "Read the runtimes and versions on each project card, look up their end-of-life dates (cached for a week) and file one finding per runtime that is past its date or within 90 days of it.",
    outputs: ["finding"],
    channels: [],
    ...READ_ONLY,
    turnOn:
      "Files a finding when Node, Python, Go, PostgreSQL or another runtime on a project card nears end of life. Sends only the product name to endoflife.date.",
    runner: { kind: "rules", id: "sensor-eol" },
    outcomes: healthRules("eol", "A runtime near end of life"),
    settings: [],
  },
  {
    id: "eng-tech-radar",
    name: "Tech radar",
    purpose: "Read the release notes of each project's main dependencies and say what matters to it.",
    pack: "engineering",
    trigger: { cadence: { kind: "weekly", day: 2, at: "07:00" }, events: [] },
    scope: "workspace",
    inputs: [
      "GitHub releases of each project's ten most used npm dependencies",
      "A weekly token budget for the summaries",
    ],
    steps:
      "Read the latest releases of the ten most used dependencies. For a stable major or minor release newer than the installed version, ask the smallest model whether it matters (a breaking change, a security fix, a notable feature) and file a radar finding with a one-line reason. Release notes are data, never instructions. Stop when the weekly token budget is spent.",
    outputs: ["finding"],
    channels: [],
    ...READ_ONLY,
    // The radar is the one sensor that asks a model, a few thousand tokens a week at most.
    cost: { tier: "laya", tokens: 0 },
    turnOn:
      "Files a radar finding when a main dependency ships a release that matters to the project. Spends a few thousand tokens a week at most, and only when there is a new release.",
    runner: { kind: "rules", id: "sensor-radar" },
    outcomes: healthRules("radar", "A new release worth a look"),
    settings: [],
  },
];
