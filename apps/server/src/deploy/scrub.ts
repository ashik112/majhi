import { detectSecrets, replaceSecrets } from "@majhi/shared";

/** A text with every secret it holds replaced. What a host or a provider printed is never kept as it came. */
export function scrubSecrets(text: string): string {
  return replaceSecrets(text, detectSecrets(text), () => "[secret]");
}
