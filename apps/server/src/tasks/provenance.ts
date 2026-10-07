import type { StoredOrigin } from "@majhi/shared";
import { PRIVATE } from "@majhi/shared";
import { UserError } from "../errors.ts";

/**
 * What a creator tells `TaskService.create` about where the new task came from. Every creator says,
 * so no task is made without an origin by accident:
 *  - `owner` and `captain`: made by hand or by the captain, with its reason.
 *  - `ref`: made from something that lives in a workspace (a finding, a watch, a schedule, a deploy). The
 *    workspace is the one the creator found the thing in; the task must be in the same one.
 *  - `child`: made under a parent (`input.parent`); its origin is that link, never stored twice.
 *  - `chat`: a chat has no origin and no type.
 */
export type Provenance =
  | { kind: "owner" }
  | { kind: "captain"; reason: string }
  | {
      kind: "ref";
      origin: Extract<StoredOrigin, { kind: "finding" | "watch" | "schedule" | "deploy" | "client" }>;
      workspace: string;
    }
  | { kind: "child" }
  | { kind: "chat" };

/**
 * The origin to store for a new task, or undefined when it stores none (a child, a chat). Refuses
 * a reference into another workspace, and a child with no parent.
 */
export function originFor(
  provenance: Provenance,
  task: { org: string | undefined; parent: string | undefined },
): StoredOrigin | undefined {
  switch (provenance.kind) {
    case "owner":
      return { kind: "owner" };
    case "captain":
      return { kind: "captain", reason: provenance.reason };
    case "ref": {
      const own = task.org ?? PRIVATE;
      if (provenance.workspace !== own) {
        throw new UserError(
          `This task is in ${own}, but its ${provenance.origin.kind} is in ${provenance.workspace}. A task only points at things in its own workspace.`,
          409,
        );
      }
      return provenance.origin;
    }
    case "child":
      if (task.parent === undefined) throw new UserError("A child task names its parent.");
      return undefined;
    case "chat":
      return undefined;
  }
}
