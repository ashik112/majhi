import type { Layout } from "../types";
import { layered } from "./layered";

/** Each box beyond what leads to it, left to right or top to bottom, whichever fits a frame better. The default. */
export const flow: Layout = (d, o) => layered(d, { direction: "AUTO", nodeGap: 22, layerGap: 44, layerGapDown: 24 }, o);
