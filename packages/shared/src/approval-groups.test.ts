import { describe, expect, it } from "vitest";
import {
  AGENT_BLOCKED_COMMANDS,
  APPROVAL_GROUP_DEFS,
  APPROVAL_GROUP_IDS,
  applyPreset,
  approvalGroupOf,
  approvalGroups,
  commandLabel,
  effectiveMode,
  type PolicyModes,
  policyChanges,
  withCommandMode,
} from "./approval-groups.ts";
import { type CommandName, commands } from "./commands.ts";

const defaults: PolicyModes = {
  read: "auto",
  change: "when-asked",
  destructive: "confirm",
  outbound: "confirm",
  commands: {},
};

describe("approval groups", () => {
  it("puts a command that no group lists under Other changes", () => {
    expect(approvalGroupOf("widgets.frobnicate")).toBe("other");
    expect(approvalGroupOf("agents.create")).toBe("other");
    expect(approvalGroupOf("tasks.create")).toBe("bookkeeping");
    expect(commandLabel("widgets.frobnicate")).toBe("widgets.frobnicate");
  });

  it("lists every command an agent can call that is not a read, exactly once", () => {
    const listed = approvalGroups().flatMap((g) => g.commands.map((c) => c.name));
    const cardable = (Object.keys(commands) as CommandName[]).filter(
      (n) => commands[n].risk !== "read" && !AGENT_BLOCKED_COMMANDS.has(n),
    );
    expect([...listed].sort()).toEqual([...cardable].sort());
    expect(listed.filter((n) => AGENT_BLOCKED_COMMANDS.has(n as CommandName))).toEqual([]);
    // A group's own list names only real commands, so a renamed command cannot vanish from it.
    for (const id of APPROVAL_GROUP_IDS) {
      for (const name of APPROVAL_GROUP_DEFS[id].commands) expect(Object.hasOwn(commands, name)).toBe(true);
    }
  });
});

describe("per-command modes", () => {
  it("lets a command's own mode win over its risk class, and drops one equal to it", () => {
    const set = withCommandMode(defaults, "tasks.create", "change", "auto");
    expect(effectiveMode(set, "tasks.create", "change")).toBe("auto");
    expect(effectiveMode(set, "tasks.close", "change")).toBe("when-asked");
    expect(withCommandMode(set, "tasks.create", "change", "when-asked").commands).toEqual({});
  });

  it("Hands-off runs task work alone and asks before shipping, deleting and remotes", () => {
    const groups = approvalGroups();
    const next = applyPreset(defaults, "hands-off", groups);
    const mode = (name: CommandName) => effectiveMode(next, name, commands[name].risk);
    expect(mode("tasks.create")).toBe("auto");
    expect(mode("containers.preview.run")).toBe("auto");
    expect(mode("projects.register")).toBe("auto");
    expect(mode("projects.update")).toBe("confirm");
    expect(mode("orgs.setGitAccount")).toBe("confirm");
    expect(mode("tasks.merge")).toBe("confirm");
    expect(mode("tasks.remove")).toBe("confirm");
    // Other changes keep what they had.
    expect(mode("agents.create")).toBe("when-asked");
    expect(next.change).toBe("when-asked");
  });

  it("Careful asks for every change and lists what moves", () => {
    const groups = approvalGroups();
    const from = withCommandMode(defaults, "tasks.create", "change", "auto");
    const next = applyPreset(from, "careful", groups);
    expect(next.commands).toEqual({});
    const changes = policyChanges(from, next, groups);
    expect(changes.every((c) => c.to === "confirm")).toBe(true);
    expect(changes.find((c) => c.command === "tasks.create")).toMatchObject({ from: "auto", to: "confirm" });
    expect(changes.some((c) => c.command === "tasks.remove")).toBe(false);
  });
});
