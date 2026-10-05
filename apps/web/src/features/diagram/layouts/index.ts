import type { DiagramLayout } from "@majhi/shared";
import type { Layout } from "../types";
import { flow } from "./flow";
import { radial } from "./radial";
import { sequence } from "./sequence";
import { state } from "./state";
import { timeline } from "./timeline";
import { topDown } from "./top-down";
import { tree } from "./tree";

/**
 * Every layout, by its id in `DIAGRAM_LAYOUTS`. To add one: put the file next to these, add its id to
 * `DIAGRAM_LAYOUTS` in `packages/shared/src/diagram.ts`, and add one line here. The type of this record
 * makes the compiler refuse a missing line.
 */
export const layouts: Record<DiagramLayout, Layout> = {
  flow,
  "top-down": topDown,
  tree,
  radial,
  sequence,
  timeline,
  state,
};
