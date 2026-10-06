import type { ScanContext } from "./context.ts";
import { scanComponents } from "./scan-components.ts";
import { scanCompose } from "./scan-compose.ts";
import { scanDotenv } from "./scan-env.ts";
import { scanKube } from "./scan-kube.ts";
import { scanMarkers } from "./scan-markers.ts";
import { scanMembers } from "./scan-members.ts";

/**
 * One kind of config file that shows facts about the repo. It reads what `readRepo` already parsed (`RepoScan`),
 * never the disk, and adds facts with the lines that show them. The sealed reader's own findings (routes, queue
 * consumers, timers, calls) are added after these, from `reader.json` (`scan-reader.ts`).
 *
 * To add one: write `scan-<thing>.ts` with a function `(ctx) => void`, have `read.ts` load the file it needs, and add a
 * line to `FACT_SOURCES`.
 */
export interface FactSource {
  id: string;
  scan(ctx: ScanContext): void;
}

export const FACT_SOURCES: readonly FactSource[] = [
  { id: "manifests", scan: scanMembers },
  { id: "components", scan: scanComponents },
  { id: "compose", scan: scanCompose },
  { id: "env-example", scan: scanDotenv },
  { id: "kubernetes", scan: scanKube },
  { id: "deploy-files", scan: scanMarkers },
];
