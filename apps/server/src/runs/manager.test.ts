import type { PermissionAsk } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const services = () => w.h.majhi.services;
const live = () => services().room.getLive("ACM-1", "acme-builder");

/** Items of the task in the order they appeared. */
async function items(task = "ACM-1"): Promise<RoomItem[]> {
  const page = await w.h.cmd("room.items", { task, limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}

/** A permission request. A field set to `undefined` is left out. */
const ask = (over: { [K in keyof PermissionAsk]?: PermissionAsk[K] | undefined } = {}): PermissionAsk => {
  const full: Record<string, unknown> = {
    title: "Run npm test",
    kind: "execute",
    command: "npm test",
    toolCallId: "t1",
    options: [
      { id: "allow", name: "Allow", kind: "allow_once" },
      { id: "always", name: "Allow for this task", kind: "allow_always" },
      { id: "reject", name: "Deny", kind: "reject_once" },
    ],
    ...over,
  };
  for (const key of Object.keys(full)) if (full[key] === undefined) delete full[key];
  return full as unknown as PermissionAsk;
};

describe("permissions", () => {
  it("never asks for what stays inside the task, and asks for what leaves it", async () => {
    w = await taskWorld({ agent: { perms: [] } });
    const answers: (string | undefined)[] = [];
    const inside = [
      { kind: "read", title: "Read", command: undefined },
      { kind: "edit", title: "Edit a.ts", command: undefined },
      { kind: "execute", title: "cd api && pnpm test", command: "cd api && pnpm test" },
      { kind: "execute", title: "docker pull postgres:16-alpine", command: "docker pull postgres:16-alpine" },
    ];
    w.h.runtime.onSession = (s) => {
      s.script = async (turn) => {
        for (const [n, one] of inside.entries())
          answers.push(await turn.ask(ask({ ...one, toolCallId: `t${n}` })));
        answers.push(await turn.ask(ask({ title: "git push origin main", command: "git push origin main" })));
        return "end_turn";
      };
    };
    await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true });
    await until(() => live()?.status === "waiting", "the push prompt");
    expect(answers).toEqual(["allow", "allow", "allow", "allow"]);
    // Only the push is a card: the four before it left no room item at all.
    const cards = (await items()).filter((i) => i.type === "permission");
    expect(cards.map((c) => [c.type === "permission" ? c.title : "", c.state])).toEqual([
      ["git push origin main", "pending"],
    ]);
    await w.h.cmd("room.cancel", { task: "ACM-1" });
  });
});
