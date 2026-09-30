import { detectSecrets } from "@majhi/shared";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** A phone number: digits in groups of 2 to 4 with spaces or dashes, after an optional `+` and country code. A dotted run is an address or a version, not a phone. */
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s-]\d{3,4}[\s-]\d{3,4}\b/;

/**
 * Why a text must never be kept, or undefined when the rules find nothing: a secret (token, key,
 * password, as `detectSecrets` knows them) or personal data (an email address, a phone number).
 * A rules check, before any model: what it flags is rejected whatever a model says.
 */
export function forbiddenReason(text: string): string | undefined {
  if (detectSecrets(text).length > 0) return "It looks like it holds a secret.";
  if (EMAIL.test(text)) return "It holds an email address.";
  if (PHONE.test(text)) return "It holds a phone number.";
  return undefined;
}
