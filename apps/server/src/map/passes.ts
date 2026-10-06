/**
 * The passes of one map update, as data. Each declares what it costs: `free` runs in code, `model` asks the
 * cheapest model. The update's estimate and its "reads config only" fallback follow this list, so a new
 * pass is one entry here and one function in `service.ts`'s `run`.
 *
 * Adding a source of lines that read files (a new parser: Gradle, Cargo, Terraform) does not touch this
 * list: it is one file in `config/` that implements `ProjectSource` and one line in `config/sources.ts`.
 */
export interface MapPass {
  id: "config" | "graph" | "history" | "code";
  cost: "free" | "model";
  /** What the progress line says while it runs. */
  doing: string;
}

export const MAP_PASSES: readonly MapPass[] = [
  { id: "config", cost: "free", doing: "Reading config files" },
  { id: "graph", cost: "free", doing: "Reading the code graph" },
  { id: "history", cost: "free", doing: "Reading what tasks changed together" },
  { id: "code", cost: "model", doing: "Reading code for links the config misses" },
];

/** Whether the update spends model tokens at all. */
export const SPENDS_TOKENS = MAP_PASSES.some((p) => p.cost === "model");
