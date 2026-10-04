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
  {
    id: "biz-client-update",
    name: "Client update",
    purpose: "Draft a short weekly update for the client, from what shipped, in your voice.",
    pack: "business",
    trigger: { cadence: { kind: "weekly", day: 5, at: "15:00" }, events: [] },
    scope: "workspace",
    inputs: [
      "Tasks that shipped this week, merge requests, open risks, incidents and what is next",
      "Your voice profile and the knowledge base entries closest to the update",
      "The contact tagged main-contact in the CRM",
    ],
    steps:
      "Code gathers the week's facts. The smallest model writes a short update in your voice from them. The draft is an email to the client's main contact and waits for your approval. If no contact is tagged main-contact, the draft says so and asks you to pick one. A week with nothing shipped and no incident makes no draft.",
    outputs: ["draft", "log"],
    channels: ["email"],
    cost: { tier: "small", tokens: 6_000 },
    enabledByDefault: false,
    turnOn:
      "Drafts a client update every Friday afternoon, about 2,000 tokens of the smallest model. Nothing is sent: each draft waits in Decisions.",
    outcomes: [{ id: "update-draft", text: "A week with news: draft the update, it waits in Needs you" }],
    runner: { kind: "rules", id: "client-update" },
    settings: [],
  },
];
