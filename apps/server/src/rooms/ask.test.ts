import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(async () => {
  await w?.cleanup();
});

const roomItems = async (id: string) =>
  (await w.h.cmd("room.items", { task: id, limit: 200 })).body.items as RoomItem[];

const postAskCard = async (
  taskId: string,
  questions: Array<{
    id: string;
    question: string;
    options: Array<{ id: string; label: string }>;
    default?: string;
    freeText: boolean;
  }>,
  agent?: string,
) => {
  const coordinator = w.h.majhi.services.coordinator;
  const task = w.h.majhi.services.store.tasks.get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const actualAgent = agent || task.team[0];
  if (!actualAgent) throw new Error("No agent found");
  const card = await coordinator.postAskCard(taskId, actualAgent, questions);
  if (card.type !== "ask") throw new Error("Expected ask card");
  return card;
};

const findAskCard = async (id: string) =>
  (await roomItems(id)).find((i) => i.type === "ask") as (RoomItem & { type: "ask" }) | undefined;

describe("room.answerAsk routing", () => {
  it("answering a single-question card marks it answered with 'Owner chose' format", async () => {
    w = await taskWorld();
    const res = await w.h.cmd("tasks.create", {
      text: "ACM api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const taskId = res.body.id;

    const card = await postAskCard(taskId, [
      {
        id: "q1",
        question: "Pick one",
        options: [
          { id: "opt1", label: "Option A" },
          { id: "opt2", label: "Option B" },
        ],
        freeText: false,
      },
    ]);

    expect(card.type).toBe("ask");
    expect(card.state).toBe("pending");

    const answer = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: card.id,
      answers: { q1: "opt1" },
    });

    expect(answer.status).toBe(200);
    const updated = await findAskCard(taskId);
    expect(updated?.state).toBe("answered");
    expect(updated?.answers).toEqual({ q1: "opt1" });
  });

  it("answering a multi-question card marks all answers", async () => {
    w = await taskWorld();
    const res = await w.h.cmd("tasks.create", {
      text: "ACM api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const taskId = res.body.id;

    const card = await postAskCard(taskId, [
      {
        id: "q1",
        question: "First",
        options: [{ id: "a", label: "Answer A" }],
        freeText: false,
      },
      {
        id: "q2",
        question: "Second",
        options: [{ id: "b", label: "Answer B" }],
        freeText: false,
      },
    ]);

    const answer = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: card.id,
      answers: { q1: "a", q2: "b" },
    });

    expect(answer.status).toBe(200);
    const updated = await findAskCard(taskId);
    expect(updated?.answers).toEqual({ q1: "a", q2: "b" });
  });

  it("rejects answering twice on the same card", async () => {
    w = await taskWorld();
    const res = await w.h.cmd("tasks.create", {
      text: "ACM api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const taskId = res.body.id;

    const card = await postAskCard(taskId, [
      {
        id: "q1",
        question: "Pick",
        options: [{ id: "opt", label: "Option" }],
        freeText: false,
      },
    ]);

    const first = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: card.id,
      answers: { q1: "opt" },
    });

    expect(first.status).toBe(200);

    const second = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: card.id,
      answers: { q1: "opt" },
    });

    expect(second.status).toBe(409);
  });

  it("rejects answers not in the options when freeText is false", async () => {
    w = await taskWorld();
    const res = await w.h.cmd("tasks.create", {
      text: "ACM api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const taskId = res.body.id;

    const card = await postAskCard(taskId, [
      {
        id: "q1",
        question: "Pick from list",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        freeText: false,
      },
    ]);

    const answer = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: card.id,
      answers: { q1: "invalid" },
    });

    expect(answer.status).toBe(409);
  });

  it("accepts free-text answers when freeText is true", async () => {
    w = await taskWorld();
    const res = await w.h.cmd("tasks.create", {
      text: "ACM api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const taskId = res.body.id;

    const card = await postAskCard(taskId, [
      {
        id: "q1",
        question: "Tell us",
        options: [{ id: "predefined", label: "Predefined" }],
        freeText: true,
      },
    ]);

    const answer = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: card.id,
      answers: { q1: "some custom text" },
    });

    expect(answer.status).toBe(200);
    const updated = await findAskCard(taskId);
    expect(updated?.answers?.q1).toBe("some custom text");
  });

  it("rejects answers for non-existent items", async () => {
    w = await taskWorld();
    const res = await w.h.cmd("tasks.create", {
      text: "ACM api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const taskId = res.body.id;

    const answer = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: "nonexistent",
      answers: { q1: "opt" },
    });

    expect(answer.status).toBe(409);
  });

  it("rejects missing answers for required questions", async () => {
    w = await taskWorld();
    const res = await w.h.cmd("tasks.create", {
      text: "ACM api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const taskId = res.body.id;

    const card = await postAskCard(taskId, [
      {
        id: "q1",
        question: "First",
        options: [{ id: "a", label: "A" }],
        freeText: false,
      },
      {
        id: "q2",
        question: "Second",
        options: [{ id: "b", label: "B" }],
        freeText: false,
      },
    ]);

    const answer = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: card.id,
      answers: { q1: "a" },
    });

    expect(answer.status).toBe(409);
  });

  it("routes answered ask to the non-lead agent who called it", async () => {
    w = await taskWorld();
    const res = await w.h.cmd("tasks.create", {
      text: "ACM api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const taskId = res.body.id;
    const task = w.h.majhi.services.store.tasks.get(taskId);
    if (!task) throw new Error("Task not found");
    const lead = task.team[0];

    const createRes = await w.h.cmd("agents.create", {
      id: "acme-reviewer",
      frontmatter: { scope: "acme", role: "Reviewer", account: "claude-acme", perms: ["edit"] },
      instructions: "Review things.\n",
    });
    if (createRes.status !== 200) throw new Error(`agents.create failed: ${createRes.status}`);

    const addRes = await w.h.cmd("team.add", { task: taskId, agent: "acme-reviewer" });
    if (addRes.status !== 200) throw new Error(`team.add failed: ${addRes.status}`);

    const card = await postAskCard(
      taskId,
      [
        {
          id: "q1",
          question: "Pick",
          options: [{ id: "opt", label: "Option" }],
          freeText: false,
        },
      ],
      "acme-reviewer",
    );

    expect(card.agent).toBe("acme-reviewer");
    expect(card.agent).not.toBe(lead);

    const answer = await w.h.cmd("room.answerAsk", {
      task: taskId,
      item: card.id,
      answers: { q1: "opt" },
    });

    expect(answer.status).toBe(200);
    const items = await roomItems(taskId);
    const ownerMsg = items.find((i) => i.type === "owner" && i.text.includes("Owner chose"));
    if (!ownerMsg || ownerMsg.type !== "owner") throw new Error("Owner message not found");
    expect(ownerMsg.to).toBe("acme-reviewer");
    expect(ownerMsg.to).not.toBe(lead);
  });
});
