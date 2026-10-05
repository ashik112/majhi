import { describe, expect, it } from "vitest";
import { clipboardCopy, LINUX_CLIPBOARD, MAC_CLIPBOARD } from "./clipboard.ts";
import { type FakeProgram, failed, fakeOs, ok } from "./fakeOs.ts";

const KEY = "sk-live-9f2c41d7a8b35e60";

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

  it("goes on to the next program when one is missing or fails, and is false when none works", async () => {
    const { deps, runs } = copier({
      "/usr/bin/xclip": () => failed(1),
      "/usr/bin/xsel": () => ok(),
    });
    expect(await clipboardCopy(deps, LINUX_CLIPBOARD, KEY)).toBe(true);
    expect(runs.map((run) => [run.file, ...run.args])).toEqual([
      ["/usr/bin/xclip", "-selection", "clipboard"],
      ["/usr/bin/xsel", "--clipboard", "--input"],
    ]);
    expect(await clipboardCopy(copier({}).deps, LINUX_CLIPBOARD, KEY)).toBe(false);
  });
});
