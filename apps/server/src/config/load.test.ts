import { describe, expect, it } from "vitest";
import { parseConfigText } from "./load.ts";

const HOME = "/home/owner";
const FILE = "/home/owner/.majhi/majhi.yaml";

function parse(text: string) {
  return parseConfigText(text, HOME, FILE);
}

describe("parseConfigText", () => {
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
});
