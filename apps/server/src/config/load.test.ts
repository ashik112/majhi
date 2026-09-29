import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { loadConfig, parseConfigText } from "./load.ts";

const HOME = "/home/owner";
const FILE = "/home/owner/.majhi/majhi.yaml";

function parse(text: string) {
  return parseConfigText(text, HOME, FILE);
}

describe("loadConfig", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it("reports first run when majhi.yaml does not exist", async () => {
    const { state } = await loadConfig({ majhiHome: dir, hostHome: HOME });
    expect(state).toEqual({ status: "first-run", file: join(dir, "majhi.yaml"), home: HOME });
  });

  it("loads a file from disk", async () => {
    await writeFile(join(dir, "majhi.yaml"), "workspaces: [~/Work]\n");
    const { state } = await loadConfig({ majhiHome: dir, hostHome: HOME });
    expect(state).toMatchObject({ status: "loaded", config: { workspaces: ["/home/owner/Work"] } });
  });
});

describe("parseConfigText", () => {
  it("reports YAML syntax errors with their line", () => {
    const { state } = parse("workspaces: [~/Work\ntasks_dir: ~/x\n");
    expect(state.status).toBe("invalid");
    if (state.status !== "invalid") return;
    expect(state.errors.length).toBeGreaterThan(0);
    expect(state.errors[0]).toMatch(/line \d+/);
    expect(state.errors[0]).not.toContain("\n");
  });

  it("reports schema errors as `path: message`, one per issue", () => {
    const { state } = parse("workspaces: [Work, ~/ok]\ntasks_dir: tasks\n");
    expect(state).toMatchObject({
      status: "invalid",
      errors: [
        "workspaces[0]: Use an absolute path, or one starting with ~/",
        "tasks_dir: Use an absolute path, or one starting with ~/",
      ],
    });
  });

  it("rejects an empty workspace list", () => {
    expect(parse("workspaces: []\n").state).toMatchObject({
      status: "invalid",
      errors: ["workspaces: Add at least one workspace root"],
    });
  });

  it("rejects unknown top-level keys by name", () => {
    expect(parse("workspaces: [~/Work]\nworkspace_roots: [~/x]\n").state).toMatchObject({
      status: "invalid",
      errors: ["workspace_roots: Unknown key"],
    });
  });

  it("treats an empty file as invalid, not as first run", () => {
    expect(parse("# nothing yet\n").state.status).toBe("invalid");
  });

  it("expands ~ against the host home and normalizes paths", () => {
    const { state } = parse("workspaces: [~/Work, /srv/code/, ~/a/../b]\ntasks_dir: ~/tasks\n");
    expect(state).toMatchObject({
      status: "loaded",
      home: HOME,
      config: {
        workspaces: ["/home/owner/Work", "/srv/code", "/home/owner/b"],
        tasksDir: "/home/owner/tasks",
      },
    });
  });

  it("drops a root listed twice, even when written differently", () => {
    const { state } = parse("workspaces: [~/Work, /home/owner/Work/]\n");
    expect(state).toMatchObject({ status: "loaded", config: { workspaces: ["/home/owner/Work"] } });
  });

  it("puts the tasks folder under the first root by default", () => {
    const { state } = parse("workspaces: [~/Work, ~/personal]\n");
    expect(state).toMatchObject({ status: "loaded", config: { tasksDir: "/home/owner/Work/.majhi" } });
  });

  it("reads the path of every registered project", () => {
    const text = [
      "workspaces: [~/Work]",
      "projects:",
      "  api: { org: acme, path: ~/Work/acme/api }",
      "  web: { org: acme, path: /srv/web, aliases: [Frontend] }",
    ].join("\n");
    expect(parse(text).projectPaths).toEqual(["/home/owner/Work/acme/api", "/srv/web"]);
  });

  it("marks the config invalid when a project is malformed", () => {
    const text = [
      "workspaces: [~/Work]",
      "projects:",
      "  broken: just-a-string",
      "  nopath: { org: acme }",
    ].join("\n");
    const loaded = parse(text);
    expect(loaded.state.status).toBe("invalid");
    expect(loaded.projectPaths).toEqual([]);
  });
});
