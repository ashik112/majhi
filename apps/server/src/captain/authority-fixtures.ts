import type { Authority } from "@majhi/shared";

/** The three old levels as rows, for tests that set a workspace through `autonomy.configure`. */
export const RUNS: Authority = {
  start: "decide",
  questions: "decide",
  approvals: "decide",
  upkeep: "decide",
  merge: "ask",
  push: "ask",
  own: "ask",
};
export const TIDY: Authority = { ...RUNS, start: "ask" };
export const ASK: Authority = {
  start: "ask",
  questions: "ask",
  approvals: "ask",
  upkeep: "ask",
  merge: "ask",
  push: "ask",
  own: "ask",
};
