import { highlightParts } from "./filter";

/** Text with the search terms marked. */
export function Highlight({ text, terms }: { text: string; terms: readonly string[] }) {
  return highlightParts(text, terms).map((part, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
    part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
  );
}
