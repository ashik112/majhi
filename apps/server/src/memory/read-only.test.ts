import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionAsk } from "@majhi/acp";
import { describe, expect, it } from "vitest";
import { readOnlyHandler } from "./read-only.ts";

const ROOT = "/Users/owner/.majhi/.wiki/acme/api/src-0123";
const OPTIONS: PermissionAsk["options"] = [
  { id: "yes", name: "Allow", kind: "allow_once" },
  { id: "always", name: "Always", kind: "allow_always" },
  { id: "no", name: "Reject", kind: "reject_once" },
];
const ask = (kind: string | undefined, locations?: string[]): PermissionAsk => ({
  title: "A tool call",
  ...(kind === undefined ? {} : { kind }),
  ...(locations === undefined ? {} : { locations }),
  options: OPTIONS,
});

describe("the read-only permission handler", () => {
  const decide = readOnlyHandler(ROOT);

  it("allows once a read or a search inside the export", async () => {
    expect(await decide(ask("read", [`${ROOT}/src/app.py`]))).toBe("yes");
    expect(await decide(ask("search", [ROOT]))).toBe("yes");
  });

  it("rejects a read or a search that names no place", async () => {
    expect(await decide(ask("search"))).toBe("no");
    expect(await decide(ask("read", []))).toBe("no");
  });

  it("rejects a read through a link in the export that leads out of it", async () => {
    const base = await mkdtemp(join(tmpdir(), "read-only-"));
    const root = join(base, "src-0123");
    await mkdir(root);
    await mkdir(join(base, "account"));
    await writeFile(join(base, "account", "credentials.json"), "{}");
    await symlink(join(base, "account"), join(root, "docs"));
    await writeFile(join(root, "app.py"), "print(1)");
    const decideIn = readOnlyHandler(root);
    expect(await decideIn(ask("read", [join(root, "docs", "credentials.json")]))).toBe("no");
    expect(await decideIn(ask("read", [join(root, "app.py")]))).toBe("yes");
  });

  it("rejects edit, delete, move, execute, fetch, an MCP tool and a request of no kind", async () => {
    for (const kind of ["edit", "delete", "move", "execute", "fetch", "switch_mode", "other", undefined]) {
      expect(await decide(ask(kind, [`${ROOT}/src/app.py`])), String(kind)).toBe("no");
    }
  });

  it("rejects a read of a file outside the export, by an absolute path or by ..", async () => {
    expect(await decide(ask("read", ["/Users/owner/.majhi/accounts/claude-acme/.credentials.json"]))).toBe(
      "no",
    );
    expect(await decide(ask("read", [`${ROOT}/../src-9999/app.py`]))).toBe("no");
    expect(await decide(ask("read", [`${ROOT}/src/app.py`, "/etc/passwd"]))).toBe("no");
  });

  it("reads the other exports of a workspace, and nothing beside them", async () => {
    const web = "/Users/owner/.majhi/.wiki/acme/web/src-4567";
    const both = readOnlyHandler(ROOT, [web]);
    expect(await both(ask("read", [`${web}/src/main.tsx`]))).toBe("yes");
    expect(await both(ask("read", [`${ROOT}/src/app.py`, `${web}/package.json`]))).toBe("yes");
    expect(await both(ask("read", ["/Users/owner/.majhi/.wiki/acme/other/src-8910/app.py"]))).toBe("no");
    expect(await both(ask("read", [`${web}/../../api/graph/graph.json`]))).toBe("no");
    expect(await decide(ask("read", [`${web}/src/main.tsx`]))).toBe("no");
  });

  it("cancels when the request offers no option to answer with", async () => {
    expect(await decide({ ...ask("execute"), options: OPTIONS.slice(0, 1) })).toBeUndefined();
  });
});
