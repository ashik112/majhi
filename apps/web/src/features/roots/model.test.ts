import { describe, expect, it } from "vitest";
import {
  breadcrumbs,
  checkNewRoot,
  checkRoots,
  defaultTasksDir,
  draftFromConfig,
  parentPath,
  type RootsDraft,
} from "./model";

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

describe("checkNewRoot", () => {
  const rows = [
    { id: 0, value: "~/Work" },
    { id: 1, value: "" },
  ];

  it("returns the trimmed path for a new root", () => {
    expect(checkNewRoot("  /srv/code ", rows, HOME)).toEqual({ value: "/srv/code" });
  });

  it("rejects a root that is already listed under another spelling", () => {
    expect(checkNewRoot("/home/me/Work/", rows, HOME)).toEqual({ error: "Already a root" });
  });

  it("rejects relative and empty paths with the schema's messages", () => {
    expect(checkNewRoot("Work", rows, HOME)).toEqual({
      error: "Use an absolute path, or one starting with ~/",
    });
    expect(checkNewRoot("   ", rows, HOME)).toEqual({ error: "Path is empty" });
  });
});

describe("breadcrumbs", () => {
  it("starts paths under home at ~", () => {
    expect(breadcrumbs("/home/me/Work/ops", HOME)).toEqual([
      { label: "~", path: "/home/me" },
      { label: "Work", path: "/home/me/Work" },
      { label: "ops", path: "/home/me/Work/ops" },
    ]);
    expect(breadcrumbs("/home/me", `${HOME}/`)).toEqual([{ label: "~", path: "/home/me" }]);
  });

  it("starts other paths at /, and does not mistake a sibling of home for home", () => {
    expect(breadcrumbs("/home/meta/x", HOME)).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "meta", path: "/home/meta" },
      { label: "x", path: "/home/meta/x" },
    ]);
    expect(breadcrumbs("/", HOME)).toEqual([{ label: "/", path: "/" }]);
  });
});

describe("parentPath", () => {
  it("goes up one folder and stops at /", () => {
    expect(parentPath("/home/me/Work/")).toBe("/home/me");
    expect(parentPath("/srv")).toBe("/");
    expect(parentPath("/")).toBeNull();
  });
});
