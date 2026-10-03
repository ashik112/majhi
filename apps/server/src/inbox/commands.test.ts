import type { OwnerDecision } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;

afterEach(async () => {
  await w?.cleanup();
});

describe("decisions.* through the command table", () => {
  it("lists a waiting card, refuses an agent's answer, and gives the owner's answer to the card", async () => {
    w = await taskWorld();
    expect(
      (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: false }))
        .status,
    ).toBe(200);
    w.h.majhi.services.room.post("ACM-1", "q1", {
      type: "choice",
      agent: "acme-builder",
      question: "Which queue should the export use?",
      options: [
        { id: "redis", label: "Redis" },
        { id: "sqs", label: "SQS" },
      ],
      state: "pending",
    });

    const listed = await w.h.cmd("decisions.list", {});
    expect(listed.status).toBe(200);
    const decisions = (listed.body as { decisions: OwnerDecision[] }).decisions;
    expect(decisions).toEqual([
      expect.objectContaining({
        id: "room:ACM-1:q1",
        kind: "question",
        title: "Which queue should the export use?",
        options: [
          { id: "redis", label: "Redis", primary: true },
          { id: "sqs", label: "SQS" },
        ],
      }),
    ]);

    const agent = await w.h.cmd(
      "decisions.answer",
      { id: "room:ACM-1:q1", option: "sqs" },
      { actor: { kind: "agent", id: "acme-builder" } },
    );
    expect(agent.status).toBe(409);
    expect(w.h.majhi.services.room.get("ACM-1", "q1")).toMatchObject({ state: "pending" });

    const owner = await w.h.cmd("decisions.answer", { id: "room:ACM-1:q1", option: "sqs" });
    expect(owner.status).toBe(200);
    expect((owner.body as { decisions: OwnerDecision[] }).decisions).toEqual([]);
    expect(w.h.majhi.services.room.get("ACM-1", "q1")).toMatchObject({ state: "answered", chosen: "sqs" });
  });
});
