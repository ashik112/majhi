import { readFile } from "node:fs/promises";
// A namespace import: the server bundle's banner already declares `createRequire`.
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { FONT_MONO, FONT_SANS } from "./theme.ts";

/**
 * The fonts an exported page embeds, the Latin cut only (about 60 KB): Plex Sans regular and semibold,
 * Plex Mono regular. They come from the same @fontsource packages the web app uses; the server image
 * copies just these files (Dockerfile, `runtime-build`).
 */
const FACES = [
  {
    family: FONT_SANS,
    weight: 400,
    pkg: "@fontsource/ibm-plex-sans",
    file: "ibm-plex-sans-latin-400-normal.woff2",
  },
  {
    family: FONT_SANS,
    weight: 600,
    pkg: "@fontsource/ibm-plex-sans",
    file: "ibm-plex-sans-latin-600-normal.woff2",
  },
  {
    family: FONT_MONO,
    weight: 400,
    pkg: "@fontsource/ibm-plex-mono",
    file: "ibm-plex-mono-latin-400-normal.woff2",
  },
] as const;

let faces: Promise<string> | undefined;

/**
 * `@font-face` rules with the fonts inlined, read once. Empty when the files are not there: the page
 * then falls back to the system fonts in its stack, which is still a readable document.
 */
export function fontFaces(): Promise<string> {
  faces ??= load();
  return faces;
}

async function load(): Promise<string> {
  const require = nodeModule.createRequire(import.meta.url);
  const rules = await Promise.all(
    FACES.map(async (face) => {
      try {
        // The packages export LICENSE, not their files folder: find the folder next to it.
        const folder = dirname(require.resolve(`${face.pkg}/LICENSE`));
        const data = await readFile(join(folder, "files", face.file));
        return `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:block;src:url(data:font/woff2;base64,${data.toString("base64")}) format("woff2")}`;
      } catch {
        return "";
      }
    }),
  );
  return rules.join("\n");
}
