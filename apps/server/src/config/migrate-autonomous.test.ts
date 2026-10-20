import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dropLegacyAutonomous, legacyAutonomousKeys } from "./migrate-autonomous.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const OLD = `# The owner's file
autonomy:
  day:
    cost: 20 # kept
  pick:
    size: small
  orgs:
    acme:
      level: routine
      tasksAtOnce: 3
      hours:
        from: "09:00"
        to: "18:00"
      freeze:
        - from: 2026-12-24
          to: 2026-12-26
    globex:
      level: ask
`;

describe("the move to Autonomous's own rules", () => {
  it("takes the old keys out of majhi.yaml, keeps everything else and the comments, and leaves a copy of the old file", async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-autonomous-"));
    const file = join(dir, "majhi.yaml");
    await writeFile(file, OLD);

    expect(await legacyAutonomousKeys(file)).toEqual([
      "autonomy.pick",
      "autonomy.orgs.acme.tasksAtOnce",
      "autonomy.orgs.acme.hours",
    ]);
    await dropLegacyAutonomous(file);

    const after = await readFile(file, "utf8");
    expect(after).toContain("# The owner's file");
    expect(after).toContain("cost: 20 # kept");
    expect(after).toContain("level: routine");
    expect(after).toContain("level: ask");
    expect(after).toContain("2026-12-24");
    for (const gone of ["pick", "size: small", "tasksAtOnce", "hours", "09:00"]) {
      expect(after).not.toContain(gone);
    }
    // The old file is kept beside it, whole, and no half-written temp file is left.
    expect(await readFile(`${file}.before-autonomous`, "utf8")).toBe(OLD);
    expect((await readdir(dir)).sort()).toEqual(["majhi.yaml", "majhi.yaml.before-autonomous"]);
    // A second run finds nothing, and the copy stays the first old file.
    expect(await legacyAutonomousKeys(file)).toEqual([]);
  });
});
