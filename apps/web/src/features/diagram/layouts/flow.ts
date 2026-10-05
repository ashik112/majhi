import type { Layout } from "../types";
import { layered } from "./layered";

/** Left to right: each box to the right of what leads to it. The default. */
export const flow: Layout = (d) => layered(d, { rankdir: "LR", nodesep: 40, ranksep: 120 });
