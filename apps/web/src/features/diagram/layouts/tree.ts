import type { Layout } from "../types";
import { layered } from "./layered";

/** A hierarchy from the top: the root, then its children in a row below, and so on. Tight, for org charts and folder trees. */
export const tree: Layout = (d, o) => layered(d, { direction: "DOWN", nodeGap: 24, layerGap: 56 }, o);
