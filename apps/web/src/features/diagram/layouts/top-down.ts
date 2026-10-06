import type { Layout } from "../types";
import { layered } from "./layered";

/** Top to bottom: each box under what leads to it. */
export const topDown: Layout = (d, o) =>
  layered(d, { direction: "DOWN", nodeGap: 22, layerGap: 44, layerGapDown: 24 }, o);
