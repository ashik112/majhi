import { describe, expect, it } from "vitest";
import { resumeSignedIn } from "./resume-signed-in.ts";

describe("resumeSignedIn", () => {
  it("resumes a task whose own account signed in, and not one waiting on another account", async () => {
    const started: string[] = [];
    const accountOfAgent: Record<string, string> = {
      "globex-lead": "claude-globex",
      "acme-lead": "claude-acme",
    };
    const resumed = await resumeSignedIn({
      paused: () => [
        { id: "GLX-1", team: ["globex-lead"] },
        { id: "ACM-1", team: ["acme-lead"] },
      ],
      accountOf: async (_task, agent) => accountOfAgent[agent],
      needsLogin: async (account) => account === "claude-acme",
      start: async (id) => {
        started.push(id);
      },
    });
    expect(resumed).toEqual(["GLX-1"]);
    expect(started).toEqual(["GLX-1"]);
  });
});
