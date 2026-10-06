import type { PermissionAsk } from "@majhi/acp";
import type { Perm } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { decidePermission, isMajhiTool, neededPerm } from "./permissions.ts";

const options: PermissionAsk["options"] = [
  { id: "allow", name: "Allow", kind: "allow_once" },
  { id: "always", name: "Always", kind: "allow_always" },
  { id: "reject", name: "Reject", kind: "reject_once" },
];
const ask = (kind: string | undefined, command?: string): PermissionAsk => ({
  title: command ?? "Do a thing",
  ...(kind === undefined ? {} : { kind }),
  ...(command === undefined ? {} : { command }),
  options,
});
const decide = (a: PermissionAsk, perms: Perm[], remembered: string[] = []) =>
  decidePermission(a, { perms, rememberedFor: (k) => remembered.includes(k) });

describe("neededPerm", () => {
  it.each([
    ["read", undefined, "none"],
    ["search", undefined, "none"],
    ["fetch", undefined, "none"],
    ["edit", undefined, "edit"],
    ["delete", undefined, "edit"],
    ["move", undefined, "edit"],
    ["execute", "npm test", "shell"],
    ["execute", "git status", "shell"],
    ["execute", "git pull origin main", "shell"],
    ["execute", "git fetch --all --prune", "shell"],
    ["execute", "cd x && git pull --ff-only", "shell"],
    ["execute", "git push origin main", "push"],
    ["execute", "cd x && git -C y push --force", "push"],
    ["execute", "sh -c 'git push'", "push"],
    ["execute", "gh pr create --fill", "mr"],
    ["other", undefined, "unknown"],
    [undefined, undefined, "unknown"],
  ] as const)("%s %s needs %s", (kind, command, need) => {
    expect(neededPerm({ title: "t", ...(kind ? { kind } : {}), ...(command ? { command } : {}) })).toBe(need);
  });
});

describe("decidePermission", () => {
  it("always allows reads, searches and fetches, even with no perms", () => {
    expect(decide(ask("read"), [])).toEqual({ action: "allow", option: "allow", via: "perms" });
    expect(decide(ask("search"), [])).toEqual({ action: "allow", option: "allow", via: "perms" });
    expect(decide(ask("fetch"), [])).toEqual({ action: "allow", option: "allow", via: "perms" });
  });

  it("allows edits, deletes and moves with edit", () => {
    expect(decide(ask("edit"), ["edit"]).action).toBe("allow");
    expect(decide(ask("delete"), ["edit"]).action).toBe("allow");
    expect(decide(ask("move"), ["shell"]).action).toBe("ask");
  });

  it("allows commands with shell, but git push needs push", () => {
    expect(decide(ask("execute", "npm test"), ["shell"]).action).toBe("allow");
    expect(decide(ask("execute", "npm test"), ["edit"]).action).toBe("ask");
    expect(decide(ask("execute", "git push"), ["shell"]).action).toBe("ask");
    expect(decide(ask("execute", "git push"), ["push"]).action).toBe("allow");
  });

  it("lets an agent with shell sync from the remote without asking, while a push still asks", () => {
    for (const line of ["git pull origin main", "git fetch origin", "git -C sub pull --ff-only"]) {
      expect(decide(ask("execute", line), ["shell"]).action, line).toBe("allow");
    }
    expect(decide(ask("execute", "git pull origin main && git push"), ["shell"]).action).toBe("ask");
    expect(decide(ask("execute", "git push origin main"), ["shell"]).action).toBe("ask");
  });

  it("asks for kinds it does not know", () => {
    expect(decide(ask("other"), ["edit", "shell", "push"]).action).toBe("ask");
    expect(decide(ask(undefined), ["edit", "shell", "push"]).action).toBe("ask");
  });

  it("uses a remembered allow for the task and kind, except for pushes", () => {
    expect(decide(ask("execute", "npm test"), [], ["execute"])).toEqual({
      action: "allow",
      option: "allow",
      via: "task",
    });
    expect(decide(ask("execute", "npm test"), [], ["edit"]).action).toBe("ask");
    expect(decide(ask("execute", "git push"), [], ["execute"]).action).toBe("ask");
    expect(decide(ask("other"), [], ["other"]).action).toBe("allow");
  });

  it("picks allow_always when there is no allow_once, and asks when nothing allows", () => {
    const onlyAlways: PermissionAsk = {
      ...ask("read"),
      options: [{ id: "a", name: "A", kind: "allow_always" }],
    };
    expect(decide(onlyAlways, []).action).toBe("allow");
    const onlyReject: PermissionAsk = {
      ...ask("read"),
      options: [{ id: "r", name: "R", kind: "reject_once" }],
    };
    expect(decide(onlyReject, ["edit"]).action).toBe("ask");
  });
});

describe("isMajhiTool", () => {
  it("matches only majhi's own MCP servers, never lookalikes", () => {
    expect(isMajhiTool("mcp__majhi-admin__majhi_tasks_remove")).toBe(true);
    expect(isMajhiTool("mcp__majhi-decide__decide")).toBe(true);
    expect(isMajhiTool("mcp__majhi-room__record_plan")).toBe(true);
    expect(isMajhiTool("mcp__majhi-tasks__create")).toBe(true);
    expect(isMajhiTool("mcp__majhi-memory__recall")).toBe(true);
    expect(isMajhiTool("mcp__majhi-containers__service_start")).toBe(true);
    // Processes run commands: never waved through as a majhi tool.
    expect(isMajhiTool("mcp__majhi-processes__start")).toBe(false);
    expect(isMajhiTool("mcp__majhi-admin-evil__majhi_tasks_remove")).toBe(false);
    expect(isMajhiTool("mcp__other__majhi_tasks_remove")).toBe(false);
    expect(isMajhiTool("Run mcp__majhi-admin__x && rm -rf ~")).toBe(false);
    expect(isMajhiTool("mcp__majhi-admin__x; rm -rf ~")).toBe(false);
  });
});
