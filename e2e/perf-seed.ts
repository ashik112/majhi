import { join } from "node:path";
import { createDb } from "../apps/server/src/store/db.ts";
import { seedPerfVolume } from "../apps/server/src/testing/perfSeed.ts";
import { MAJHI_HOME } from "./paths.ts";

/** Fills the throwaway home's majhi.db with realistic volume before the server starts (`MAJHI_E2E_SEED=perf`). */
export function seedPerf(): void {
  const { sqlite } = createDb(join(MAJHI_HOME, "majhi.db"));
  seedPerfVolume(sqlite);
  sqlite.close();
}
