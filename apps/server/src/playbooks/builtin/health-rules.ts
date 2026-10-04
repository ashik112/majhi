import type { Playbook } from "@majhi/shared";

/**
 * The outcome rules of the code health sensors. `${prefix}-finding` files the finding, `${prefix}-task`
 * proposes a fix task in the inbox from it (off until the owner wants it; the task is never started),
 * `${prefix}-brief` lets it count in the morning brief. The sensors read them through `reporterOf`.
 */
export function healthRules(prefix: string, found: string): NonNullable<Playbook["outcomes"]> {
  return [
    { id: `${prefix}-finding`, text: `${found}: file a finding` },
    { id: `${prefix}-task`, text: "Propose a fix task in the inbox. It is never started", default: false },
    { id: `${prefix}-brief`, text: "Tell me in the morning brief" },
  ];
}
