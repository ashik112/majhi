import { type ApprovalMode, hideSecrets } from "@majhi/shared";

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
  return hideSecrets(text, REDACTED);
}
