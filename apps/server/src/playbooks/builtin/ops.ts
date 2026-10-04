import type { Playbook } from "@majhi/shared";

/**
 * The ops watch pack (`apps/server/src/ops`): the services the owner lists on the Watch page, checked
 * as code. It spends no tokens until a failure is confirmed; then the incident wakes the captain.
 * Its switch, cadence and history are the playbook's; the services, counts and incidents are the watch's.
 */

export const OPS_PLAYBOOKS: Playbook[] = [
  {
    id: "ops-uptime",
    name: "Service watch",
    purpose: "Watch the services you list and open an incident when one stays down.",
    pack: "ops",
    trigger: { cadence: { kind: "every", minutes: 5 }, events: [] },
    scope: "workspace",
    inputs: [
      "The services listed on the Watch page: address, status, keyword, latency, certificate, name lookup",
      "A monitoring connection's read tool, when one is set",
    ],
    steps:
      "Request each address (a status below 400 within its limits is up). Look at certificates and names once a day. A failure gets a second look at once; 2 of the last 3 looks failing opens one incident (a finding, severity by impact) and wakes the captain with the evidence. Green for 10 minutes closes it with a timeline. No network here means unknown, never down.",
    outputs: ["finding", "log"],
    channels: [],
    cost: { tier: "rules", tokens: 0 },
    enabledByDefault: false,
    readOnly: true,
    watch: true,
    turnOn: "Checks your services every 5 minutes. A confirmed failure opens an incident and wakes the captain.",
    runner: { kind: "rules", id: "uptime" },
    settings: [],
  },
];
