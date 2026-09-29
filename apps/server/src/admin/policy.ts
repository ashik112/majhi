import {
  type ApprovalMode,
  detectSecrets,
  type PolicySettings,
  type RiskClass,
  replaceSecrets,
} from "@majhi/shared";

export type Decision = "run" | "pending";

/** The mode that applies to a command: its own override, else its risk class. */
export function modeFor(policy: PolicySettings, command: string, risk: RiskClass): ApprovalMode {
  return policy.commands[command] ?? policy[risk];
}

/**
 * `auto` runs. `when-asked` runs when the agent says the owner asked for it in the conversation.
 * `confirm` always waits for the owner's click.
 */
export function decide(mode: ApprovalMode, ownerAsked: boolean): Decision {
  if (mode === "auto") return "run";
  if (mode === "when-asked" && ownerAsked) return "run";
  return "pending";
}

const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|private|credential|^value$/i;
export const REDACTED = "[redacted]";

/** A copy of the input safe to show in the room: secret-looking fields and strings are hidden. */
export function redact(input: unknown): unknown {
  if (typeof input === "string") return redactText(input);
  if (Array.isArray(input)) return input.map(redact);
  if (typeof input === "object" && input !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      // A secret reference like `secret:name` is not a secret, so a `key` field holding one stays.
      const isRef = typeof value === "string" && /^secret:[a-z0-9-]+$/.test(value);
      // Commands type every secret as text, so a count like `inputTokens: 1200` is not one.
      const plain = typeof value === "number" || typeof value === "boolean";
      out[key] =
        SENSITIVE_KEY.test(key) && !isRef && !plain && value !== null && value !== ""
          ? REDACTED
          : redact(value);
    }
    return out;
  }
  return input;
}

/** Text with every detected secret hidden. */
export function redactText(text: string): string {
  return replaceSecrets(text, detectSecrets(text), () => REDACTED);
}
