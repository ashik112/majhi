import { describe, expect, it } from "vitest";
import { clipboardCopy, MAC_CLIPBOARD } from "./clipboard.ts";
import { type FakeProgram, fakeOs, ok } from "./fakeOs.ts";

const KEY = "Zq-live-9f2c41d7a8b35e60";

function copier(programs: Record<string, FakeProgram>) {
  const os = fakeOs({ programs });
  const deps = { run: os.deps.run, find: os.deps.find, env: async () => ({ PATH: os.deps.path }) };
  return { deps, runs: os.runs };
}

describe("clipboardCopy", () => {
  it("gives the text on stdin and never in the arguments", async () => {
    const { deps, runs } = copier({ "/usr/bin/pbcopy": () => ok() });
    expect(await clipboardCopy(deps, MAC_CLIPBOARD, KEY)).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.options.input).toBe(KEY);
    expect(JSON.stringify(runs[0]?.args)).not.toContain(KEY);
  });
});
