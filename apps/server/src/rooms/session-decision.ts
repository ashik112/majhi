import type { PermissionAsk } from "@majhi/acp";

/** What a session's own rule says about one tool request: allow it, or refuse it with the reason the agent reads. */
export type SessionDecision = { allow: true } | { allow: false; why: string };

/** A session's own rule for its tool requests. A run does not have one: it goes through the permission flow. */
export type Decider = (ask: PermissionAsk) => Promise<SessionDecision>;

/**
 * The permission handler `setPermissionHandler` takes, made from a session's rule: the option of the kind the rule
 * asks for, or undefined (the ask is cancelled) when the request has none. The same rule answers Codex's hook in a
 * runner (`CodexHookGate`), so a session's tools are judged the same way on both paths.
 */
export function handlerOf(decide: Decider): (ask: PermissionAsk) => Promise<string | undefined> {
  return async (ask) => {
    const wanted = (await decide(ask)).allow ? ["allow_once"] : ["reject_once", "reject_always"];
    for (const kind of wanted) {
      const option = ask.options.find((o) => o.kind === kind);
      if (option !== undefined) return option.id;
    }
    return undefined;
  };
}

/** A session that only answers: every tool request is refused with `why`. */
export function refuseAll(why: string): Decider {
  return async () => ({ allow: false, why });
}
