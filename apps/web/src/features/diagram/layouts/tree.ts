import type { Layout } from "../types";
import { layered } from "./layered";

/** A hierarchy from the top: the root, then its children in a row below, and so on. Tight, for org charts and folder trees. */
export const tree: Layout = (d) =>
  layered(d, { rankdir: "TB", nodesep: 28, ranksep: 70, ranker: "tight-tree" });
