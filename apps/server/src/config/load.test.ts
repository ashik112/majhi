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

  it("loads a file that still has the removed loop guard and review rounds", () => {
    const text = [
      "workspaces: [~/Work]",
      "rooms: { max_agent_turns: 20, review_rounds: 3 }",
      "orgs:",
      "  acme:",
      "    name: Acme",
      "    rooms: { max_agent_turns: 8, review_before_owner: true }",
      "",
    ].join("\n");
    expect(parse(text).state.status).toBe("loaded");
  });
});
