import { errorMessage } from "../errors.ts";
import { BadReply } from "../memory/housekeeper.ts";

/** What the owner reads when the writer's model answered, but not in a form majhi can use. */
export const UNREADABLE_ANSWER = "The captain's answer could not be read.";

/** A failure of a model call as one plain line: a reply that could not be parsed never shows the parser's words. */
export function plainReason(err: unknown): string {
  return err instanceof BadReply ? UNREADABLE_ANSWER : errorMessage(err);
}
