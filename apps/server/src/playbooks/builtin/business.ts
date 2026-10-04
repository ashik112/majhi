import type { Playbook } from "@majhi/shared";

/**
 * The Business pack (captain v2 step 11): what a client costs and earns, and a weekly update drafted
 * for them. Economics is code and reads only. The client update spends one small-model call per week
 * and writes a draft that waits for the owner: nothing is sent.
 */

export const BUSINESS_PLAYBOOKS: Playbook[] = [
  {
    id: "biz-economics",
    name: "Client economics",
    purpose: "Compare each workspace's shipped work, agent time, spend and your time with the week before.",
    pack: "business",
    trigger: { cadence: { kind: "weekly", day: 1, at: "07:30" }, events: [] },
    scope: "workspace",
    inputs: [
      "Shipped tasks, agent runs, spend and your own actions in this workspace",
      "The retainer and hourly rate you entered under Money (none are guessed)",
    ],
    steps:
      "Read the last seven days against the seven before. File one analysis finding per flag: spend growing faster than shipped work, nothing shipped in 14 days, spend near the retainer. One per workspace, flag and week. With no retainer there is no margin to show.",
    outputs: ["finding"],
    channels: [],
    cost: { tier: "rules", tokens: 0 },
    enabledByDefault: true,
    readOnly: true,
    turnOn:
      "Files a finding when a workspace spends more without shipping more, goes quiet, or nears its retainer. No model, no tokens.",
    outcomes: [
      { id: "econ-finding", text: "A flag trips (spend, quiet, near budget): file a finding" },
      { id: "econ-close", text: "A flag clears: close its finding" },
    ],
    runner: { kind: "rules", id: "economics" },
    settings: [],
  },
];
