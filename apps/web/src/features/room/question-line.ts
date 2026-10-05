import type { RoomItem } from "@majhi/shared";

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
