import type { Playbook } from "@majhi/shared";

/**
 * The ops watch pack, kept minimal (the full pack is captain v2 step 6a): a plain uptime check for URLs
 * the owner lists. It runs as code and spends no tokens until something fails.
 */

export const OPS_PLAYBOOKS: Playbook[] = [
  {
    id: "ops-uptime",
    name: "Service up check",
    purpose: "Check that the URLs you list answer, and file an incident when one stays down.",
    pack: "ops",
    trigger: { cadence: { kind: "every", minutes: 5 }, events: [] },
    scope: "workspace",
    inputs: ["The URLs listed in this playbook's settings"],
    steps:
      "Request each URL. A status below 400 within 10 seconds is up. A URL that fails twice in a row files one incident finding (severity high) and wakes the captain. A URL that answers again closes its incident as fixed.",
    outputs: ["finding", "log"],
    channels: [],
    cost: { tier: "rules", tokens: 0 },
    enabledByDefault: false,
    turnOn: "Checks the URLs you list every 5 minutes. A failure files an incident and wakes the captain.",
    runner: { kind: "rules", id: "uptime" },
    settings: [
      { key: "urls", label: "URLs to check", hint: "One per line, like https://acme.example/health" },
    ],
  },
];
