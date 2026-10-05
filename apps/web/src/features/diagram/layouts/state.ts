import type { Layout } from "../types";
import { layered } from "./layered";

/** A state machine: states left to right, wider apart so the labels of transitions fit, a transition to itself loops. */
export const state: Layout = (d) => layered(d, { rankdir: "LR", nodesep: 110, ranksep: 190 });
