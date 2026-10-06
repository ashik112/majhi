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
    expect(await decide(ask("search"))).toBe("yes");
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

  it("cancels when the request offers no option to answer with", async () => {
    expect(await decide({ ...ask("execute"), options: OPTIONS.slice(0, 1) })).toBeUndefined();
  });
});
