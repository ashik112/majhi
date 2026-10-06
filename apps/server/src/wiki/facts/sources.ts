import type { Resolver } from "../system/resolver.ts";
import type { MapBuilder } from "./builder.ts";
import type { Loaded } from "./facts.ts";
import { bindServices, scanCompose } from "./scan-docker.ts";
import { scanDotenv } from "./scan-env.ts";
import { scanKube } from "./scan-kube.ts";
import { scanPackageJson, scanPython } from "./scan-manifests.ts";

/** What a source gets when it scans one project: the other projects (to link to) and the graph to add to. */
export interface ScanContext {
  resolver: Resolver;
  b: MapBuilder;
}

/**
 * One kind of config file that shows links between projects. It reads what `loadProject` already parsed
 * (`Loaded`), never the disk, and adds boxes and lines with proof. The config files themselves are read
 * once per project and cached by their size and time, so an unchanged project costs a few `stat` calls.
 *
 * To add one: write `scan-<thing>.ts` with a function `(loaded, ctx) => void`, have `facts.ts` load the file
 * it needs, and add a line to `PROJECT_SOURCES`.
 */
export interface ProjectSource {
  id: string;
  /** `free`: runs in code. A source that asked a model would say `model` and be counted in the estimate. */
  cost: "free" | "model";
  scan(loaded: Loaded, ctx: ScanContext): void;
}

export const PROJECT_SOURCES: readonly ProjectSource[] = [
  { id: "package-json", cost: "free", scan: scanPackageJson },
  { id: "python", cost: "free", scan: scanPython },
  { id: "compose", cost: "free", scan: scanCompose },
  { id: "env-example", cost: "free", scan: scanDotenv },
  { id: "kubernetes", cost: "free", scan: scanKube },
];

/** Steps that look across every project before any source scans one (compose services name projects). */
export const PRE_SCANS: readonly ((all: readonly Loaded[], resolver: Resolver) => void)[] = [bindServices];
