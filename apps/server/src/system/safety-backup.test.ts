import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostLink } from "../host/link.ts";
import { SystemService } from "./service.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "majhi-system-backup-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  return rm(home, { recursive: true, force: true });
});

describe("update safety backup", () => {
  it("keeps the server running and reports recovery instructions when the backup fails", async () => {
    const link = new HostLink();
    vi.spyOn(link, "status").mockReturnValue({
      connected: true,
      info: { version: "1", platform: "darwin", canRemount: true },
    });
    const call = vi.spyOn(link, "call");
    const system = new SystemService({
      hostLink: link,
      commit: "dev",
      majhiHome: home,
      beforeUpdate: async () => {
        throw new Error("disk full");
      },
    });
    const result = await system.update();
    expect(result.state).toBe("manual");
    if (result.state === "manual") {
      expect(result.reason).toContain("Check Backups and free disk space");
      expect(result.reason).toContain("disk full");
    }
    expect(call).not.toHaveBeenCalled();
    system.close();
  });
});
