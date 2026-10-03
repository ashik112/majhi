import { describe, expect, it } from "vitest";
import { type FakeProgram, failed, fakeOs, ok } from "./fakeOs.ts";
import { openUrl } from "./openUrl.ts";

describe("openUrl", () => {
  const page = "http://127.0.0.1:7070/t/ACM-12?tab=files&q=a b";

  function opener(programs: Record<string, FakeProgram>) {
    const os = fakeOs({ programs });
    const deps = { run: os.deps.run, find: os.deps.find, env: async () => ({ PATH: os.deps.path }) };
    return { deps, runs: os.runs };
  }

  it("opens only http(s) pages, and runs nothing for anything else", async () => {
    const { deps, runs } = opener({ "/usr/bin/xdg-open": () => ok() });
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://acme.example/share",
      "--help",
      "",
    ]) {
      expect(await openUrl(deps, ["xdg-open"], url)).toBe(false);
    }
    expect(runs).toEqual([]);
  });

  it("gives the URL as one argument to the first opener that works", async () => {
    // WSL2: wslview failed, and explorer.exe answers 1 even when it opened the page.
    const { deps, runs } = opener({
      "/usr/bin/wslview": () => failed(1),
      "/usr/bin/explorer.exe": () => failed(1),
    });
    expect(await openUrl(deps, ["xdg-open", "wslview", "explorer.exe"], page)).toBe(true);
    expect(runs.map((run) => [run.file, ...run.args])).toEqual([
      ["/usr/bin/wslview", "http://127.0.0.1:7070/t/ACM-12?tab=files&q=a%20b"],
      ["/usr/bin/explorer.exe", "http://127.0.0.1:7070/t/ACM-12?tab=files&q=a%20b"],
    ]);

    const linux = opener({ "/usr/bin/xdg-open": () => failed(1) });
    expect(await openUrl(linux.deps, ["xdg-open"], page)).toBe(false);
  });
});
