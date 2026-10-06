/**
 * The look of an exported document: majhi's light theme (apps/web/src/styles.css), flattened onto white
 * paper. The HTML stylesheet and the Word styles both read these, so html, pdf and docx match.
 */
export const INK = {
  text: "#0e1726",
  soft: "#273447",
  muted: "#435166",
  faint: "#55637a",
  line: "#d3dae3",
  wash: "#f3f5f8",
  link: "#2a64b8",
} as const;

export const FONT_SANS = "IBM Plex Sans";
export const FONT_MONO = "IBM Plex Mono";

/** highlight.js classes and their colours, as the viewer's palette assigns them. */
export const CODE_COLORS: Readonly<Record<string, string>> = {
  comment: "#8a96a6",
  quote: "#8a96a6",
  keyword: "#6d4bc4",
  "selector-tag": "#6d4bc4",
  doctag: "#6d4bc4",
  string: "#0f7d5c",
  regexp: "#0f7d5c",
  addition: "#0f7d5c",
  number: "#95590a",
  literal: "#95590a",
  symbol: "#95590a",
  bullet: "#95590a",
  title: "#2a64b8",
  section: "#2a64b8",
  name: "#2a64b8",
  tag: "#2a64b8",
  attr: "#b3502d",
  attribute: "#b3502d",
  property: "#b3502d",
  variable: "#b3502d",
  "template-variable": "#b3502d",
  params: "#b3502d",
  type: "#a83c78",
  built_in: "#a83c78",
  "selector-class": "#a83c78",
  "selector-id": "#a83c78",
  meta: "#435166",
  link: "#435166",
  subst: "#435166",
  deletion: "#c2352a",
};

/** The colour of a highlight.js token from its classes (`hljs-keyword`), or undefined for plain text. */
export function codeColor(classes: readonly string[]): string | undefined {
  for (const c of classes) {
    const color = c.startsWith("hljs-") ? CODE_COLORS[c.slice(5)] : undefined;
    if (color !== undefined) return color;
  }
  return undefined;
}
