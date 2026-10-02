import { z } from "zod";

/** Longest emoji accepted, in UTF-16 code units. ZWJ families and tag flags fit; prose does not. */
export const EMOJI_MAX_LENGTH = 16;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** A pictograph, maybe with modifiers, variation selectors and ZWJ joins after it. */
const PICTOGRAPH = /^\p{Extended_Pictographic}/u;
/** Two regional indicators: a country flag. */
const FLAG = /^\p{Regional_Indicator}{2}$/u;
/** 0-9, # or *, an optional VS16, then the keycap mark. */
const KEYCAP = /^[0-9#*]️?⃣$/u;

/** True when `value` is exactly one emoji: one grapheme that is a pictograph, a flag or a keycap. */
export function isSingleEmoji(value: string): boolean {
  if (value.length === 0 || value.length > EMOJI_MAX_LENGTH) return false;
  const graphemes = [...segmenter.segment(value)];
  if (graphemes.length !== 1) return false;
  return PICTOGRAPH.test(value) || FLAG.test(value) || KEYCAP.test(value);
}

/** An agent's avatar emoji. */
export const EmojiSchema = z.string().refine(isSingleEmoji, { message: "Must be a single emoji" });
