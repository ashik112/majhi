import {
  type AllowRule,
  type ApprovalMode,
  detectSecrets,
  isDestructiveCommand,
  type PolicySettings,
  replaceSecrets,
} from "@majhi/shared";

export type Decision = "run" | "pending";

/**
 * `auto` runs. `when-asked` runs when the agent says the owner asked for it in the conversation.
 * `confirm` always waits for the owner's click.
 */
export function decide(mode: ApprovalMode, ownerAsked: boolean): Decision {
  if (mode === "auto") return "run";
  if (mode === "when-asked" && ownerAsked) return "run";
  return "pending";
}

/**
 * The saved rule that lets `agent` run `command` without asking, if there is one. A task rule covers
 * only its own task, an org rule only tasks in that org (`org` is undefined for a LOCAL task, so none
 * matches). A destructive command matches nothing: only the owner's click approves it. The caller
 * asks only when the mode says pending: a rule turns that into "run" and never blocks anything.
 */
export function matchRule(
  policy: PolicySettings,
  call: { agent: string; command: string; task: string; org: string | undefined },
): AllowRule | undefined {
  if (isDestructiveCommand(call.command)) return undefined;
  return policy.rules.find(
    (rule) =>
      rule.agent === call.agent &&
      rule.command === call.command &&
      (rule.task === undefined ? rule.org === call.org && call.org !== undefined : rule.task === call.task),
  );
}

/** True when the rule is the one named: same agent, command and scope. */
export function sameRule(a: AllowRule, b: AllowRule): boolean {
  return a.agent === b.agent && a.command === b.command && a.task === b.task && a.org === b.org;
}

const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|private|credential|^value$/i;
export const REDACTED = "[redacted]";

/** What a command answered never names a secret `value` field: `value` there is a reading or a result. */
const SENSITIVE_OUTPUT_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|private|credential/i;

/** A copy of a command's answer safe to show: secret-looking strings and fields hidden, a plain `value` kept. */
export function redactOutput(output: unknown): unknown {
  return redactWith(output, SENSITIVE_OUTPUT_KEY);
}

/** A copy of the input safe to show in the room: secret-looking fields and strings are hidden. */
export function redact(input: unknown): unknown {
  return redactWith(input, SENSITIVE_KEY);
}

function redactWith(input: unknown, sensitive: RegExp): unknown {
  if (typeof input === "string") return redactText(input);
  if (Array.isArray(input)) return input.map((v) => redactWith(v, sensitive));
  if (typeof input === "object" && input !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      // A secret reference like `secret:name` is not a secret, so a `key` field holding one stays.
      const isRef = typeof value === "string" && /^secret:[a-z0-9-]+$/.test(value);
      // Commands type every secret as text, so a count like `inputTokens: 1200` is not one.
      const plain = typeof value === "number" || typeof value === "boolean";
      out[key] =
        sensitive.test(key) && !isRef && !plain && value !== null && value !== ""
          ? REDACTED
          : redactWith(value, sensitive);
    }
    return out;
  }
  return input;
}

/** Text with every detected secret hidden. */
export function redactText(text: string): string {
  return replaceSecrets(text, detectSecrets(text), () => REDACTED);
}
