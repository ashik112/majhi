import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { prebuildTemplates } from "./world.ts";

/** A folder for the run's test world templates (`template.ts`), removed when the run ends. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = await mkdtemp(join(tmpdir(), "majhi-templates-"));
  project.provide("majhiTemplateRoot", root);
  await prebuildTemplates(root);
  return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
