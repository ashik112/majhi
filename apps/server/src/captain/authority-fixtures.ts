import { ALL_ASK, type Authority } from "@majhi/shared";

/** The three old levels as rows, for tests that set a workspace through `autonomy.configure`. */
export const RUNS: Authority = {
  ...ALL_ASK,
  start: "decide",
  questions: "decide",
  approvals: "decide",
  upkeep: "decide",
};
export const TIDY: Authority = { ...RUNS, start: "ask" };
export const ASK: Authority = { ...ALL_ASK };
