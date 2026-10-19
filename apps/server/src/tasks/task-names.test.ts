import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameFromTitle, slugOfName } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { branchName, freeBranchesTogether } from "./branch-naming.ts";
import { claimTaskFolder, nameSlug, removableFolder, wantedFolder } from "./task-folder.ts";

let dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "majhi-names-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("a task's name, its branch and its folder", () => {
  it("makes the name of an owner's sentence from its first meaningful words, and the branch from the name", () => {
    const name = nameFromTitle("fix(api): the login redirect drops the session when the cart is empty");
    expect(name).toBe("Login redirect drops session");
    expect(branchName({ id: "ACM-1", title: "ignored", name, type: "fix" })).toBe(
      "fix/login-redirect-drops-session",
    );
  });

  it("gives every repo the same free branch name, numbering all of them together when one repo has it", async () => {
    const wanted = [
      branchName({ id: "ACM-1", title: "x", name: "Login redirect", type: "feat" }),
      branchName({ id: "ACM-1", title: "x", name: "Login redirect", type: "feat" }),
    ];
    expect(wanted).toEqual(["feat/login-redirect", "feat/login-redirect"]);
    // The second repo already has `feat/login-redirect` and `feat/login-redirect-2`.
    const taken = async (repo: number, branch: string) =>
      repo === 1 && (branch === "feat/login-redirect" || branch === "feat/login-redirect-2");
    expect(await freeBranchesTogether(wanted, taken)).toEqual([
      "feat/login-redirect-3",
      "feat/login-redirect-3",
    ]);
  });

  it("numbers a folder when the name is taken in the same project, and not across projects", async () => {
    const root = tmp();
    const a = await claimTaskFolder(root, "acme-api", nameSlug("Login redirect"));
    const b = await claimTaskFolder(root, "acme-api", nameSlug("Login redirect"));
    const c = await claimTaskFolder(root, "acme-web", nameSlug("Login redirect"));
    expect([a, b, c]).toEqual([
      join(root, "acme-api", "login-redirect"),
      join(root, "acme-api", "login-redirect-2"),
      join(root, "acme-web", "login-redirect"),
    ]);
  });

  it("keeps a name with dots, slashes or an absolute path inside the tasks folder", async () => {
    const root = tmp();
    expect(slugOfName("../../etc/passwd")).toBe("etc-passwd");
    expect(slugOfName("/etc/cron.d")).toBe("etc-cron-d");
    expect(await claimTaskFolder(root, "acme-api", nameSlug("../../etc/passwd"))).toBe(
      join(root, "acme-api", "etc-passwd"),
    );
    // A part that is not one plain folder name is refused whatever made it.
    for (const [scope, slug] of [
      ["..", "x"],
      ["acme-api", ".."],
      ["acme-api", "../x"],
      ["acme-api", "/etc"],
      ["/tmp", "x"],
      ["acme-api", ".hidden"],
      ["", "x"],
    ] as const) {
      expect(() => wantedFolder(root, scope, slug), `${scope} / ${slug}`).toThrow(UserError);
    }
  });

  it("deletes only a folder strictly inside the tasks folder, never the folder itself or a link out", async () => {
    const root = tmp();
    const outside = tmp();
    const folder = await claimTaskFolder(root, "acme-api", "login-redirect");
    mkdirSync(join(root, "other"));
    symlinkSync(outside, join(root, "other", "escape"));
    expect(await removableFolder(root, folder)).toMatch(/acme-api\/login-redirect$/);
    expect(await removableFolder(root, root)).toBeUndefined();
    expect(await removableFolder(root, outside)).toBeUndefined();
    expect(await removableFolder(root, join(root, "other", "escape"))).toBeUndefined();
    expect(await removableFolder(root, join(root, "gone"))).toBeUndefined();
  });
});
