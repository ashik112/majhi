import type { RoomItem } from "@majhi/shared";

/** What a row in the "Needs you" dock is, so it can be told apart without opening it. */
export interface DockCaptionParts {
  /** The agent that asked, or majhi. */
  who: string;
  task: string;
  kind: string;
}

const KINDS: Record<RoomItem["type"], string> = {
  permission: "Permission",
  approval: "Approval",
  "secret-request": "Secret",
  ask: "Question",
  choice: "Choice",
  review: "Ready to ship",
  paused: "Paused",
  "owner-question": "Question",
  owner: "Message",
  agent: "Message",
  thought: "Thought",
  tool: "Tool",
  plan: "Plan",
  handoff: "Handoff",
  context: "Context",
  "team-plan": "Plan",
  system: "Note",
};

/** Who asked, which task it belongs to, and what kind of thing it is. */
export function dockCaption(item: RoomItem, lead: string | undefined): DockCaptionParts {
  const agent =
    "agent" in item && item.agent !== undefined ? item.agent : item.type === "review" ? item.lead : lead;
  return {
    who: item.type === "paused" || agent === undefined ? "majhi" : `@${agent}`,
    task: item.task,
    kind: KINDS[item.type],
  };
}

/**
 * The words of a plain-text question to the owner. An empty one (the agent wrote none, or only
 * code) still says who asks, so the row is never blank.
 */
export function questionLine(item: Extract<RoomItem, { type: "owner-question" }>): {
  who: string;
  text: string | undefined;
} {
  const text = (item.text ?? "").trim();
  return { who: `@${item.agent}`, text: text === "" ? undefined : text };
}

/** The line above each card in the dock: who, which task, what kind. */
export function DockCaption({ parts }: { parts: DockCaptionParts }) {
  return (
    <p className="mb-1 flex min-w-0 items-center gap-1.5 px-0.5 text-xs text-fg-faint">
      <span className="truncate font-mono text-fg-soft">{parts.who}</span>
      <span aria-hidden="true">·</span>
      <span className="tnum shrink-0 font-mono">{parts.task}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0">{parts.kind}</span>
    </p>
  );
}
