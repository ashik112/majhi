import { z } from "zod";

/** The names a stored message carries for its mention tokens (contact id to name), read from the JSON a query returns. */
export function storedMentions(stored: string | null): Readonly<Record<string, string>> | undefined {
  if (stored === null) return undefined;
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
