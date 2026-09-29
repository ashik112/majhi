/** Laya reads about 512 tokens. majhi estimates 4 characters per token. */
export const LAYA_TOKENS = 512;
const CHARS_PER_TOKEN = 4;

/** Cuts `state` to about `tokens` tokens, keeping the start, which holds the task brief. */
export function trimState(state: string, tokens = LAYA_TOKENS): { text: string; trimmed: boolean } {
  const max = tokens * CHARS_PER_TOKEN;
  if (state.length <= max) return { text: state, trimmed: false };
  return { text: `${state.slice(0, max - 1).trimEnd()}…`, trimmed: true };
}
