import { describe, expect, it } from "vitest";
import { checkRoots, defaultTasksDir, draftFromConfig, type RootsDraft } from "./model";

const HOME = "/home/me";

function draft(values: string[], tasksDir = ""): RootsDraft {
  return { rows: values.map((value, id) => ({ id, value })), tasksDir };
}

describe("checkRoots", () => {
  it("accepts ~ paths and absolute paths, trimmed, as the command input", () => {
    const check = checkRoots(draft(["  ~/Work ", "/srv/code"]), HOME);
    expect(check.rowErrors.size).toBe(0);
    expect(check.input).toEqual({ workspaces: ["~/Work", "/srv/code"] });
  });

  it("rejects relative paths with the schema's message", () => {
    const check = checkRoots(draft(["~/Work", "Work/other"]), HOME);
    expect(check.rowErrors.get(1)).toBe("Use an absolute path, or one starting with ~/");
    expect(check.input).toBeUndefined();
  });

  it("ignores blank rows, but needs at least one root", () => {
    expect(checkRoots(draft(["", "~/Work", " "]), HOME).input).toEqual({ workspaces: ["~/Work"] });
    const empty = checkRoots(draft(["", "  "]), HOME);
    expect(empty.formError).toBe("Add at least one workspace root");
    expect(empty.input).toBeUndefined();
  });

  it("flags a root listed twice, comparing expanded paths", () => {
    const check = checkRoots(draft(["~/Work", "/home/me/Work/"]), HOME);
    expect(check.rowErrors.has(0)).toBe(false);
    expect(check.rowErrors.get(1)).toBe("Already listed above");
    expect(check.input).toBeUndefined();
  });

  it("sends tasks_dir only when set, and validates it", () => {
    expect(checkRoots(draft(["~/Work"], "~/tasks"), HOME).input).toEqual({
      workspaces: ["~/Work"],
      tasks_dir: "~/tasks",
    });
    const bad = checkRoots(draft(["~/Work"], "tasks"), HOME);
    expect(bad.tasksDirError).toBe("Use an absolute path, or one starting with ~/");
    expect(bad.input).toBeUndefined();
  });
});

describe("draftFromConfig", () => {
  it("shows roots with ~ and leaves the default tasks folder blank so saving does not pin it", () => {
    const result = draftFromConfig(
      { workspaces: ["/home/me/Work", "/srv/code"], tasksDir: "/home/me/Work/.majhi" },
      HOME,
    );
    expect(result.rows.map((r) => r.value)).toEqual(["~/Work", "/srv/code"]);
    expect(result.tasksDir).toBe("");
  });

  it("keeps a custom tasks folder", () => {
    const result = draftFromConfig({ workspaces: ["/home/me/Work"], tasksDir: "/home/me/tasks" }, HOME);
    expect(result.tasksDir).toBe("~/tasks");
  });
});

describe("defaultTasksDir", () => {
  it("puts .majhi under the first root, without doubling a trailing slash", () => {
    expect(defaultTasksDir("~/Work/")).toBe("~/Work/.majhi");
  });
});
