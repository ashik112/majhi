import type { RoomItem } from "@majhi/shared";

type OwnerQuestion = Extract<RoomItem, { type: "owner-question" }>;

/**
 * The words of a plain-text question to the owner. An empty one (the agent wrote none, or only
 * code) still says who asks, so the row is never blank.
 */
export function questionLine(item: OwnerQuestion): {
  who: string;
  text: string | undefined;
} {
  const text = (item.text ?? "").trim();
  return { who: `@${item.agent}`, text: text === "" ? undefined : text };
}

/**
 * Whether the agent asked something: it offered choices, or its words hold a question mark. A message
 * that is not a question is never labelled "asks".
 */
export function isQuestion(item: OwnerQuestion): boolean {
  return item.choices.length > 0 || (item.text ?? "").includes("?");
}
