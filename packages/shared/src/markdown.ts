import remarkGfm from "remark-gfm";

export { HIGHLIGHT_OPTIONS } from "./markdown-rules.ts";

/**
 * The markdown majhi renders: GitHub flavored (tables, task lists, strikethrough, autolinks), no raw
 * HTML, code colored by its fence language only. The viewer (react-markdown in apps/web) and the
 * document export (apps/server/src/export) both build their pipeline from these, so a downloaded
 * document holds what the viewer shows.
 *
 * Its own entry (`@majhi/shared/markdown`), not the package index: the web app loads the renderer
 * lazily and must not pull it in with every other shared import.
 */
export const REMARK_PLUGINS = [remarkGfm];
