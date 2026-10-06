import type { Layout } from "../types";
import { layered } from "./layered";

/** A state machine: states left to right, wider apart so the labels of transitions fit, a transition to itself loops. */
export const state: Layout = (d, o) => layered(d, { direction: "RIGHT", nodeGap: 60, layerGap: 110 }, o);
