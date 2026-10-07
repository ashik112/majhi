import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { redactDeep, redactSecrets } from "./redact.ts";

const API_KEY = "sk-acme-live-0123456789abcdef";
const SHOWN = "[secret acme-keys.API_KEY]";

describe("redactSecrets", () => {
  it("replaces each value with its name, longest first, and leaves short values alone", () => {
    const secrets = [
      { name: "a.short", value: "abc" },
      { name: "a.key", value: "key-0123" },
      { name: "a.long", value: "key-0123-and-more" },
    ];
    expect(redactSecrets("x key-0123-and-more y key-0123 abc", secrets)).toBe(
      "x [secret a.long] y [secret a.key] abc",
    );
    expect(
      redactDeep({ a: ["key-0123", 3], b: { c: "key-0123" } }, (t) => redactSecrets(t, secrets)),
    ).toEqual({
      a: ["[secret a.key]", 3],
      b: { c: "[secret a.key]" },
    });
  });
});

describe("a run's secret values", () => {
  let w: World;
  afterEach(() => w?.cleanup());

  async function items(task: string): Promise<RoomItem[]> {
    const page = await w.h.cmd("room.items", { task, limit: 500 });
    return page.body.items as RoomItem[];
  }

  it("never reach the room, the audit log, a process's output or the report", async () => {
    w = await taskWorld({ agent: { connections: ["acme-keys"] } });
    const must = async (name: string, body: unknown) => {
      const res = await w.h.cmd(name, body);
      if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
      return res.body;
    };
    await must("connections.create", {
      org: "acme",
      id: "acme-keys",
      type: "env",
      name: "Keys",
      fields: { clis: "acme" },
      vars: { API_KEY: { kind: "secret" } },
    });
    await must("connections.setSecret", { id: "acme-keys", field: "API_KEY", list: "vars", value: API_KEY });

    w.h.runtime.onSession = (session) => {
      if (w.h.runtime.sessions.length > 0) return;
      session.script = async (turn) => {
        turn.emit({ type: "text", messageId: "m1", text: `The key is ${API_KEY}.` });
        turn.emit({
          type: "tool",
          toolCallId: "t1",
          title: `curl -H "Authorization: ${API_KEY}" https://api.acme.example`,
          kind: "execute",
          status: "completed",
          content: [
            { type: "text", text: `token=${API_KEY}` },
            { type: "diff", path: "env.txt", newText: `KEY=${API_KEY}\n` },
          ],
        });
        await turn.ask({
          title: `acme deploy --key ${API_KEY}`,
          kind: "execute",
          command: `acme deploy --key ${API_KEY}`,
          toolCallId: "t2",
          options: [
            { id: "allow", name: "Allow", kind: "allow_once" },
            { id: "reject", name: "Deny", kind: "reject_once" },
          ],
        });
        return "end_turn";
      };
    };
    const task = (await must("tasks.create", {
      text: "check the keys, repo api",
      repos: [{ project: "acme-api" }],
      kind: "ops",
      start: true,
    })) as {
      id: string;
      folder: string;
    };
    await until(async () => (await items(task.id)).some((i) => i.type === "permission"), "the prompt");
    const pending = (await items(task.id)).find((i) => i.type === "permission");
    await must("room.permission", { task: task.id, item: pending?.id, option: "reject" });
    await w.h.majhi.services.runs.idle(task.id);

    const stored = JSON.stringify(await items(task.id));
    expect(stored).not.toContain(API_KEY);
    expect(stored).toContain(`The key is ${SHOWN}.`);
    expect(stored).toContain(`KEY=${SHOWN}`);
    expect(JSON.stringify(w.h.majhi.services.store.permissions.audit(task.id))).not.toContain(API_KEY);

    // A background process gets the variable, and its output keeps it out.
    const started = await w.h.majhi.services.processes.start({
      task: task.id,
      agent: "acme-builder",
      command: 'echo "key: $API_KEY"',
      wait: true,
    });
    await until(
      () => w.h.majhi.services.processes.get(task.id, started.id)?.status !== "running",
      "the process",
    );
    expect(w.h.majhi.services.processes.output(task.id, started.id, 10)).toContain(`key: ${SHOWN}`);

    await writeFile(join(task.folder, "REPORT.md"), `# Report\n\nThe key ${API_KEY} leaked.\n`);
    const report = await must("tasks.report", { id: task.id });
    expect(report).toMatchObject({ content: `# Report\n\nThe key ${SHOWN} leaked.\n` });
  });
});
