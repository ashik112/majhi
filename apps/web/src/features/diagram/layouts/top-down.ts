import type { Layout } from "../types";
import { layered } from "./layered";

/** Top to bottom: each box under what leads to it. The Map page uses it. */
export const topDown: Layout = (d) => layered(d, { rankdir: "TB", nodesep: 24, ranksep: 96 });
